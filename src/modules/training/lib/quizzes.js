// ─────────────────────────────────────────────────────────────────────────────
// Training quizzes taken from a QR code. The rules are shared with the server
// (stack/lib/quiz.js): what a valid quiz is, how it is scored, the 80% pass.
//
//   quizzes        written and read by managers; each holds its answer key
//                  and the token its QR code carries
//   quizResponses  written only by the server when someone submits from the
//                  QR page (stack/quiz.mjs); read and removed by managers
// ─────────────────────────────────────────────────────────────────────────────
import {
  addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { logAudit } from '../../../shared/org/orgData'
import { csvRow } from '../../../shared/lib/csv'
import { QUIZ_MAX_OPTIONS, QUIZ_PASS_PERCENT, QUIZ_TEXT_MAX, quizProblems } from '../../../../stack/lib/quiz.js'

export { QUIZ_MAX_OPTIONS, QUIZ_PASS_PERCENT, quizProblems }

const quizCol = () => collection(db, 'quizzes')
const quizRef = (id) => doc(db, 'quizzes', id)
const responseCol = () => collection(db, 'quizResponses')
const responseRef = (id) => doc(db, 'quizResponses', id)

/** An unguessable, URL-safe token for a quiz's QR code (the server accepts [0-9a-z]). */
export function newQuizToken() {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 18)
}

/** The public page the QR code opens. */
export function quizUrl(token) {
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
  return `${origin}/quiz/${token}`
}

let seq = 0
const newId = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`

export const blankQuestion = () => ({ id: newId(), text: '', options: ['', ''], answer: null })

/** A quiz as it is stored: trimmed text, and the answer as an option index. */
export function cleanQuiz(form) {
  const trim = (v, max) => String(v ?? '').trim().slice(0, max)
  return {
    title: trim(form.title, QUIZ_TEXT_MAX.title),
    description: trim(form.description, QUIZ_TEXT_MAX.description),
    questions: (form.questions || []).map((q) => ({
      id: q.id || newId(),
      text: trim(q.text, QUIZ_TEXT_MAX.question),
      options: (q.options || []).map((o) => trim(o, QUIZ_TEXT_MAX.option)),
      answer: Number.isInteger(q.answer) ? q.answer : null,
    })),
  }
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
export function subscribeQuizzes(cb) {
  return onSnapshot(
    query(quizCol(), orderBy('createdAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => cb([]),
  )
}

export function subscribeQuizResponses(cb) {
  return onSnapshot(
    query(responseCol(), orderBy('submittedAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => cb([]),
  )
}

/** One quiz's responses, newest first. */
export function subscribeResponsesForQuiz(quizId, cb) {
  return onSnapshot(
    query(responseCol(), where('quizId', '==', quizId), orderBy('submittedAt', 'desc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => cb([]),
  )
}

// ── Writes (managers) ─────────────────────────────────────────────────────────
function assertValid(quiz) {
  const problems = quizProblems(quiz)
  if (problems.length) throw new Error(problems[0])
}

export async function createQuiz(form, actor) {
  const quiz = cleanQuiz(form)
  assertValid(quiz)
  const ref = await addDoc(quizCol(), {
    ...quiz,
    token: newQuizToken(),
    active: true,
    createdAt: serverTimestamp(),
    createdBy: actor?.uid || null,
    createdByName: actor?.name || '',
  })
  await logAudit(actor, 'training.quiz_create', {
    module: 'training', target: 'quiz', targetId: ref.id, targetLabel: quiz.title,
    summary: `Created quiz "${quiz.title}" (${quiz.questions.length} questions)`,
  })
  return ref.id
}

export async function updateQuiz(id, form, actor) {
  const quiz = cleanQuiz(form)
  assertValid(quiz)
  await updateDoc(quizRef(id), { ...quiz, updatedAt: serverTimestamp() })
  await logAudit(actor, 'training.quiz_update', {
    module: 'training', target: 'quiz', targetId: id, targetLabel: quiz.title,
    summary: `Updated quiz "${quiz.title}"`,
  })
}

/** Open or close a quiz to responses. A closed quiz's QR code answers "not available". */
export async function setQuizActive(quiz, active, actor) {
  await updateDoc(quizRef(quiz.id), { active: Boolean(active), updatedAt: serverTimestamp() })
  await logAudit(actor, active ? 'training.quiz_open' : 'training.quiz_close', {
    module: 'training', target: 'quiz', targetId: quiz.id, targetLabel: quiz.title,
    summary: `${active ? 'Opened' : 'Closed'} quiz "${quiz.title}" to responses`,
  })
}

/** A new QR code for the quiz: the old one stops working at once. */
export async function regenerateQuizToken(quiz, actor) {
  await updateDoc(quizRef(quiz.id), { token: newQuizToken(), updatedAt: serverTimestamp() })
  await logAudit(actor, 'training.quiz_new_code', {
    module: 'training', target: 'quiz', targetId: quiz.id, targetLabel: quiz.title,
    summary: `Issued a new QR code for quiz "${quiz.title}"; the old one no longer works`,
  })
}

export async function deleteQuiz(quiz, actor) {
  await deleteDoc(quizRef(quiz.id))
  await logAudit(actor, 'training.quiz_delete', {
    module: 'training', target: 'quiz', targetId: quiz.id, targetLabel: quiz.title,
    summary: `Deleted quiz "${quiz.title}"; its responses are kept in Quiz Results`,
  })
}

export async function deleteQuizResponse(response, actor) {
  await deleteDoc(responseRef(response.id))
  await logAudit(actor, 'training.quiz_response_delete', {
    module: 'training', target: 'quiz_response', targetId: response.id, targetLabel: response.quizTitle,
    summary: `Removed a quiz response (${response.quizTitle}, ${response.percent}%)`,
  })
}

// ── Results ───────────────────────────────────────────────────────────────────
// What one person answered: the server stores it with the response
// (answerDetail). Older responses, recorded before it did, are read against
// the quiz as it is now, which is right unless the quiz has since been edited.
export function responseAnswers(response = {}, quiz = null) {
  if (Array.isArray(response.answerDetail) && response.answerDetail.length) return response.answerDetail
  return (quiz?.questions || []).map((q, i) => ({
    question: q.text,
    chosen: (q.options || [])[response.answers?.[i]] ?? '',
    correct: response.answers?.[i] === q.answer,
  }))
}

const stamp = (v) => {
  const d = v?.toDate ? v.toDate() : new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * One quiz's results as a table: a row per response, a column per question
 * holding the option chosen and whether it was right.
 */
export function quizResultTable(quiz, responses = []) {
  const questions = (quiz?.questions || []).map((q, i) => `Q${i + 1}. ${q.text}`)
  const fixed = ['Submitted', 'Employee ID', 'Name', 'Center', 'Score', 'Total', 'Percent', 'Result', 'Certificate']
  const header = [...fixed, ...(questions.length ? questions : [])]
  const rows = responses.map((r) => {
    const answers = responseAnswers(r, quiz)
    const width = Math.max(questions.length, answers.length)
    const cells = Array.from({ length: width }, (_, i) =>
      answers[i] ? `${answers[i].chosen || '—'} (${answers[i].correct ? 'correct' : 'wrong'})` : '')
    return [
      stamp(r.submittedAt), r.employeeId, r.name, r.centerName, r.score, r.total, `${r.percent}%`,
      r.passed ? 'Passed' : 'Not passed', r.certificateNo || '', ...cells,
    ]
  })
  return { header, rows }
}

const fileName = (title, ext) =>
  `quiz-results-${String(title || 'quiz').replace(/[^\w-]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.${ext}`

function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** CSV of one quiz's results. Typed text cannot become a spreadsheet formula (shared/lib/csv). */
export function quizResultsCsv(quiz, responses) {
  const { header, rows } = quizResultTable(quiz, responses)
  return [header, ...rows].map(csvRow).join('\r\n')
}

export function downloadQuizCsv(quiz, responses) {
  // The BOM makes Excel read the file as UTF-8, so names keep their accents.
  download(new Blob(['\ufeff', quizResultsCsv(quiz, responses)], { type: 'text/csv;charset=utf-8' }), fileName(quiz?.title, 'csv'))
}

/** Excel workbook of one quiz's results (shared/lib/sheet: the one safe way to build a sheet). */
export async function downloadQuizExcel(quiz, responses) {
  const [XLSX, { aoaToSheet }] = await Promise.all([import('xlsx'), import('../../../shared/lib/sheet')])
  const { header, rows } = quizResultTable(quiz, responses)
  const wb = XLSX.utils.book_new()
  const sheet = aoaToSheet([header, ...rows])
  sheet['!cols'] = header.map((h, i) => ({ wch: i < 9 ? Math.max(12, h.length + 2) : 32 }))
  XLSX.utils.book_append_sheet(wb, sheet, 'Responses')
  XLSX.writeFile(wb, fileName(quiz?.title, 'xlsx'))
}

/** Every quiz's results as CSV, one row per response (Quiz Results tab). */
export function responsesCsv(responses = []) {
  const head = ['Submitted', 'Quiz', 'Employee ID', 'Name', 'Center', 'Score', 'Total', 'Percent', 'Result', 'Certificate']
  const rows = responses.map((r) => [
    stamp(r.submittedAt), r.quizTitle, r.employeeId, r.name, r.centerName,
    r.score, r.total, r.percent, r.passed ? 'Pass' : 'Fail', r.certificateNo || '',
  ])
  return [head, ...rows].map(csvRow).join('\r\n')
}
