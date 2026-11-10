// Training quizzes taken from a QR code: the rules, pure, so every one is
// tested without a server.
//
// A manager writes a multiple-choice quiz in Training → Quiz, with the right
// option for each question, and prints its QR code. Whoever scans it gives
// their employee ID, name and centre and answers; the server scores the
// answers against the stored key and records the result. 80% or more earns a
// certificate.
//
// The answer key never leaves the server. The quiz page is built from
// publicQuizView, which drops it, and the score is computed here from the
// stored quiz, never taken from the browser: a score the taker's own browser
// worked out is a score the taker can type.

export const QUIZ_PASS_PERCENT = 80
export const QUIZ_MAX_QUESTIONS = 100
export const QUIZ_MAX_OPTIONS = 6
export const QUIZ_TEXT_MAX = { title: 200, description: 2000, question: 1000, option: 300 }
export const TAKER_MAX = { employeeId: 40, name: 120, centerName: 120, email: 254 }

// The address a passing certificate is mailed to. The same shape the
// sign-in form accepts (stack/passwords.mjs normalizeEmail).
const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:.]+(?:\.[^\s@<>()"',;:.]+)+$/
export function quizEmail(value) {
  const email = str(value).trim().toLowerCase()
  return email.length <= TAKER_MAX.email && EMAIL.test(email) ? email : ''
}

const str = (v) => (v === undefined || v === null ? '' : String(v))
const clean = (v, max) => str(v).replace(/\s+/g, ' ').trim().slice(0, max)

/** Everything wrong with a quiz as a manager saves it: [] when it can be published. */
export function quizProblems(quiz = {}) {
  const out = []
  if (!clean(quiz.title, QUIZ_TEXT_MAX.title)) out.push('Give the quiz a title.')
  const qs = Array.isArray(quiz.questions) ? quiz.questions : []
  if (!qs.length) out.push('Add at least one question.')
  if (qs.length > QUIZ_MAX_QUESTIONS) out.push(`A quiz can have at most ${QUIZ_MAX_QUESTIONS} questions.`)
  qs.forEach((q, i) => {
    const n = i + 1
    const options = Array.isArray(q?.options) ? q.options : []
    if (!clean(q?.text, QUIZ_TEXT_MAX.question)) out.push(`Question ${n} has no text.`)
    if (options.length < 2 || options.length > QUIZ_MAX_OPTIONS) {
      out.push(`Question ${n} needs between 2 and ${QUIZ_MAX_OPTIONS} options.`)
    }
    if (options.some((o) => !clean(o, QUIZ_TEXT_MAX.option))) out.push(`Question ${n} has an empty option.`)
    const a = q?.answer
    if (!Number.isInteger(a) || a < 0 || a >= options.length) out.push(`Mark the correct option for question ${n}.`)
  })
  return out
}

/** What the quiz page may show: the questions and their options, never the answers. */
export function publicQuizView(quiz = {}) {
  return {
    title: clean(quiz.title, QUIZ_TEXT_MAX.title),
    description: clean(quiz.description, QUIZ_TEXT_MAX.description),
    passPercent: QUIZ_PASS_PERCENT,
    questions: (quiz.questions || []).map((q, i) => ({
      id: str(q?.id) || `q${i + 1}`,
      text: clean(q?.text, QUIZ_TEXT_MAX.question),
      options: (q?.options || []).map((o) => clean(o, QUIZ_TEXT_MAX.option)),
    })),
  }
}

/**
 * Check what a taker sent: their details and one chosen option per question.
 * Returns { ok: true, taker, answers } or { ok: false, reason }.
 */
export function readSubmission(quiz = {}, body = {}) {
  const taker = {
    employeeId: clean(body.employeeId, TAKER_MAX.employeeId),
    name: clean(body.name, TAKER_MAX.name),
    centerName: clean(body.centerName, TAKER_MAX.centerName),
    email: quizEmail(body.email),
  }
  if (!taker.employeeId) return { ok: false, reason: 'employee-id' }
  if (!taker.name) return { ok: false, reason: 'name' }
  if (!taker.centerName) return { ok: false, reason: 'center' }
  if (!taker.email) return { ok: false, reason: 'email' }
  const qs = quiz.questions || []
  const answers = Array.isArray(body.answers) ? body.answers : null
  if (!answers || answers.length !== qs.length) return { ok: false, reason: 'answers' }
  for (let i = 0; i < qs.length; i += 1) {
    const a = answers[i]
    if (!Number.isInteger(a) || a < 0 || a >= (qs[i]?.options || []).length) return { ok: false, reason: 'answers' }
  }
  return { ok: true, taker, answers: answers.slice() }
}

/** Score answers against the stored key. Percent is rounded down: 79.9 is not 80. */
export function scoreQuiz(quiz = {}, answers = []) {
  const qs = quiz.questions || []
  const total = qs.length
  const score = qs.reduce((n, q, i) => n + (answers[i] === q?.answer ? 1 : 0), 0)
  const percent = total ? Math.floor((score * 100) / total) : 0
  return { score, total, percent, passed: total > 0 && percent >= QUIZ_PASS_PERCENT }
}

/**
 * Each question as it was asked, the option chosen, and whether it was right.
 * Stored with the response, so editing the quiz later never changes what a
 * past response shows a manager.
 */
export function answerDetail(quiz = {}, answers = []) {
  return (quiz.questions || []).map((q, i) => ({
    question: clean(q?.text, QUIZ_TEXT_MAX.question),
    chosen: clean((q?.options || [])[answers[i]], QUIZ_TEXT_MAX.option),
    correct: answers[i] === q?.answer,
  }))
}

/**
 * The mail that carries a passing certificate: a link to it, never the
 * certificate as a file (the server's mail is text; stack/notify.js). It goes
 * to the person it certifies, at the address they gave.
 */
export function certificateMail(response, url) {
  return {
    to: response.email,
    subject: `Your certificate: ${response.quizTitle}`,
    text: [
      `Dear ${response.name},`,
      '',
      `Congratulations: you passed "${response.quizTitle}" with ${response.percent}% (${response.score} of ${response.total}).`,
      '',
      `View, print or save your certificate: ${url}`,
      `Certificate no. ${response.certificateNo}`,
      '',
      'Provided by the Safety & Security Team, Cult Fit.',
    ].join('\n'),
  }
}

/** The certificate number for a passing response: stable, and traceable to it. */
export const certificateNo = (responseId) => `CFSMS-QZ-${str(responseId).slice(0, 8).toUpperCase()}`
