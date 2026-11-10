// The two public jobs behind a training quiz's QR code (stack/lib/quiz.js).
//
// Both are answered for someone with no account, so both run as the server
// and decide everything themselves:
//   publicQuiz   the quiz the token names, without its answer key, if it is
//                accepting responses;
//   submitQuiz   the taker's details and answers, scored here against the
//                stored key and recorded in quizResponses, which only the
//                server writes and only managers read (stack/policy.mjs).
// The handler limits how often one address may call them.

import { randomUUID } from 'node:crypto'
import { answerDetail, certificateNo, publicQuizView, readSubmission, scoreQuiz } from './lib/quiz.js'

const WORKER = { role: 'ohsms_worker', uid: '' }
const TOKEN = /^[0-9a-z]{8,64}$/

async function quizFor(engine, token) {
  const t = String(token || '')
  if (!TOKEN.test(t)) return null
  const [quiz] = await engine.list(WORKER, 'quizzes', { where: [{ field: 'token', op: '==', value: t }], limit: 1 })
  // A closed or deleted quiz answers exactly like an unknown code.
  return quiz && quiz.active === true && !quiz.deletedAt ? quiz : null
}

export async function publicQuiz(engine, { token }) {
  const quiz = await quizFor(engine, token)
  if (!quiz) return { ok: false, code: 'not-found', reason: 'closed' }
  return { ok: true, quiz: publicQuizView(quiz) }
}

export async function submitQuiz(engine, { token, body = {}, now = Date.now() }) {
  const quiz = await quizFor(engine, token)
  if (!quiz) return { ok: false, code: 'not-found', reason: 'closed' }
  const read = readSubmission(quiz, body)
  if (!read.ok) return { ok: false, code: 'invalid-argument', reason: read.reason }
  const result = scoreQuiz(quiz, read.answers)
  const id = randomUUID()
  const submittedAt = new Date(now).toISOString()
  const record = {
    quizId: quiz.id,
    quizTitle: String(quiz.title || ''),
    ...read.taker,
    answers: read.answers,
    // For the manager's results page; never returned to the taker.
    answerDetail: answerDetail(quiz, read.answers),
    ...result,
    certificateNo: result.passed ? certificateNo(id) : '',
    submittedAt,
    source: 'qr',
  }
  await engine.commit(WORKER, [{ type: 'set', path: 'quizResponses', id, merge: false, data: record }])
  // What the taker sees: their own result, never which answers were wrong,
  // so one attempt does not hand out the key for the next.
  return {
    ok: true,
    result: {
      quizTitle: record.quizTitle,
      ...read.taker,
      ...result,
      certificateNo: record.certificateNo,
      submittedAt,
    },
  }
}
