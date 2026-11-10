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

import { randomBytes, randomUUID } from 'node:crypto'
import {
  answerDetail, certificateMail, certificateNo, publicQuizView, quizEmail, readSubmission, scoreQuiz,
} from './lib/quiz.js'

const WORKER = { role: 'ohsms_worker', uid: '' }
const TOKEN = /^[0-9a-z]{8,64}$/

// A passing certificate is opened by a link of its own, mailed to the person
// it certifies (/certificate/:token). Unguessable, and replaced whenever a
// manager sends the certificate again, so a link mailed to a wrong address
// stops working.
const newCertToken = () => randomBytes(18).toString('hex')
const certificateUrl = (origin, token) => `${String(origin || '').replace(/\/$/, '')}/certificate/${token}`

/** Mail one certificate and record whether it went. Never throws. */
async function mailCertificate(engine, id, record, { mail, origin }) {
  let outcome
  try {
    const r = await mail(certificateMail(record, certificateUrl(origin, record.certToken)))
    outcome = r?.sent
      ? { certificateEmailedAt: new Date().toISOString(), certificateEmailError: '' }
      : { certificateEmailError: 'not-sent' }
  } catch {
    outcome = { certificateEmailError: 'not-sent' }
  }
  await engine.commit(WORKER, [{ type: 'update', path: 'quizResponses', id, data: outcome }]).catch(() => {})
  return Boolean(outcome.certificateEmailedAt)
}

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

export async function submitQuiz(engine, { token, body = {}, now = Date.now(), mail = null, origin = '', background = null }) {
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
    certToken: result.passed ? newCertToken() : '',
    submittedAt,
    source: 'qr',
  }
  await engine.commit(WORKER, [{ type: 'set', path: 'quizResponses', id, merge: false, data: record }])
  // The certificate goes by mail after the answer, so a slow mail service
  // never holds up the result screen.
  const emailing = Boolean(result.passed && mail)
  if (emailing) {
    const sending = mailCertificate(engine, id, record, { mail, origin })
    if (background) background(sending)
    else await sending
  }
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
      // 'sending': on its way to `email`; 'unavailable': mail is not set up.
      certificateEmail: result.passed ? (emailing ? 'sending' : 'unavailable') : '',
    },
  }
}

/** A certificate opened from the link in its mail: what it shows, nothing more. */
export async function quizCertificate(engine, { token }) {
  const t = String(token || '')
  if (!/^[0-9a-f]{36}$/.test(t)) return { ok: false, code: 'not-found', reason: 'unknown' }
  const [r] = await engine.list(WORKER, 'quizResponses', { where: [{ field: 'certToken', op: '==', value: t }], limit: 1 })
  if (!r || !r.passed) return { ok: false, code: 'not-found', reason: 'unknown' }
  const { name, employeeId, centerName, quizTitle, score, total, percent, passed, certificateNo: no, submittedAt } = r
  return { ok: true, certificate: { name, employeeId, centerName, quizTitle, score, total, percent, passed, certificateNo: no, submittedAt } }
}

async function liveManager(engine, uid) {
  if (!uid) return false
  const p = await engine.get(WORKER, 'users', uid)
  return Boolean(p && p.status === 'approved' && ['admin', 'manager'].includes(p.role) && p.mustChangePassword !== true)
}

/**
 * A manager sends a passing certificate again, to the address on the response
 * or a corrected one. The link is replaced: the old one stops working.
 */
export async function resendQuizCertificate(engine, { uid, responseId, email, mail, origin }) {
  if (!(await liveManager(engine, uid))) return { ok: false, code: 'permission-denied', reason: 'not-manager' }
  if (!mail) return { ok: false, code: 'unavailable', reason: 'no-mail' }
  const id = String(responseId || '')
  const r = id ? await engine.get(WORKER, 'quizResponses', id) : null
  if (!r || !r.passed) return { ok: false, code: 'not-found', reason: 'no-certificate' }
  const to = quizEmail(email || r.email)
  if (!to) return { ok: false, code: 'invalid-argument', reason: 'email' }
  const certToken = newCertToken()
  const reissuedAt = new Date().toISOString()
  await engine.commit(WORKER, [{
    type: 'update', path: 'quizResponses', id,
    data: { email: to, certToken, certificateReissuedAt: reissuedAt, certificateReissuedBy: uid },
  }])
  const sent = await mailCertificate(engine, id, { ...r, email: to, certToken }, { mail, origin })
  return { ok: true, sent, email: to }
}
