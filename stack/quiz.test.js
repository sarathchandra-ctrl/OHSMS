import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { applySchema, createEngine } from './engine.mjs'
import { publicQuiz, quizCertificate, resendQuizCertificate, submitQuiz } from './quiz.mjs'

let engine
const TOKEN = 'quiztoken1234567ab'
const questions = [
  { id: 'q1', text: 'Extinguisher for electrical fire?', options: ['Water', 'CO2', 'Foam'], answer: 1 },
  { id: 'q2', text: 'Assembly point?', options: ['Car park', 'Roof'], answer: 0 },
  { id: 'q3', text: 'Call first?', options: ['Security', 'Friend'], answer: 0 },
  { id: 'q4', text: 'Lift in a fire?', options: ['Use it', 'Never'], answer: 1 },
  { id: 'q5', text: 'Blocked exit?', options: ['Report it', 'Ignore'], answer: 0 },
]
const taker = { employeeId: 'E-17', name: 'Asha Rao', centerName: 'Koramangala', email: 'asha@example.com' }

beforeEach(async () => {
  const db = openSqlite()
  await applySchema(db)
  engine = createEngine(db)
  await engine.commit(null, [
    { type: 'set', path: 'quizzes', id: 'qz1', merge: false, data: { title: 'Fire safety', token: TOKEN, active: true, questions } },
    { type: 'set', path: 'quizzes', id: 'qz2', merge: false, data: { title: 'Closed', token: 'closedtoken12345ab', active: false, questions } },
  ])
})

describe('a quiz opened from its QR code', () => {
  it('shows the questions without the answer key', async () => {
    const r = await publicQuiz(engine, { token: TOKEN })
    expect(r.ok).toBe(true)
    expect(r.quiz.questions).toHaveLength(5)
    expect(JSON.stringify(r)).not.toContain('answer')
  })

  it('answers a closed quiz, an unknown code and a malformed one alike', async () => {
    for (const token of ['closedtoken12345ab', 'nosuchtoken123456a', '../quizzes', '', 'A'.repeat(100)]) {
      expect(await publicQuiz(engine, { token }), token).toMatchObject({ ok: false, reason: 'closed' })
      expect(await submitQuiz(engine, { token, body: { ...taker, answers: [1, 0, 0, 1, 0] } })).toMatchObject({ ok: false })
    }
  })
})

describe('submitting', () => {
  it('scores on the server and records a pass with a certificate', async () => {
    const r = await submitQuiz(engine, { token: TOKEN, body: { ...taker, answers: [1, 0, 0, 1, 1] } })
    expect(r.result).toMatchObject({ score: 4, total: 5, percent: 80, passed: true, name: 'Asha Rao' })
    expect(r.result.certificateNo).toMatch(/^CFSMS-QZ-/)
    // Nothing about which answer was wrong goes back.
    expect(JSON.stringify(r)).not.toMatch(/correct|answers/)
    const [stored] = await engine.list(null, 'quizResponses', {})
    expect(stored).toMatchObject({ quizId: 'qz1', employeeId: 'E-17', centerName: 'Koramangala', score: 4, passed: true })
    // What each person answered, as asked, for the manager's results page.
    expect(stored.answerDetail[0]).toEqual({ question: 'Extinguisher for electrical fire?', chosen: 'CO2', correct: true })
    expect(stored.answerDetail[4]).toEqual({ question: 'Blocked exit?', chosen: 'Ignore', correct: false })
  })

  it('ignores any score, pass or certificate the browser sends', async () => {
    const r = await submitQuiz(engine, {
      token: TOKEN,
      body: { ...taker, answers: [0, 1, 1, 0, 1], score: 5, percent: 100, passed: true, certificateNo: 'FAKE' },
    })
    expect(r.result).toMatchObject({ score: 0, percent: 0, passed: false, certificateNo: '' })
    const [stored] = await engine.list(null, 'quizResponses', {})
    expect(stored).toMatchObject({ score: 0, passed: false, certificateNo: '' })
  })

  it('refuses missing details or answers, and records nothing', async () => {
    for (const body of [
      { ...taker, employeeId: '', answers: [1, 0, 0, 1, 0] },
      { ...taker, answers: [1, 0, 0] },
      { ...taker, answers: [1, 0, 0, 1, 7] },
    ]) {
      expect((await submitQuiz(engine, { token: TOKEN, body })).ok).toBe(false)
    }
    expect(await engine.list(null, 'quizResponses', {})).toEqual([])
  })
})

describe('the certificate by mail', () => {
  const pass = { ...taker, answers: [1, 0, 0, 1, 0] }
  const fail = { ...taker, answers: [0, 1, 1, 0, 1] }
  const mailer = (sent = true) => {
    const out = []
    const mail = async (m) => { out.push(m); return { sent } }
    return { mail, out }
  }
  const origin = 'https://ehs.example.com'

  it('mails a pass its certificate link, and records that it went', async () => {
    const { mail, out } = mailer()
    const r = await submitQuiz(engine, { token: TOKEN, body: pass, mail, origin })
    expect(r.result.certificateEmail).toBe('sending')
    expect(out).toHaveLength(1)
    expect(out[0].to).toBe('asha@example.com')
    const link = out[0].text.match(/https:\/\/ehs\.example\.com\/certificate\/([0-9a-f]{36})/)
    expect(link).not.toBeNull()
    const [stored] = await engine.list(null, 'quizResponses', {})
    expect(stored.certificateEmailedAt).toBeTruthy()
    // The link opens the certificate, and only the certificate.
    const c = await quizCertificate(engine, { token: link[1] })
    expect(c.certificate).toMatchObject({ name: 'Asha Rao', percent: 100, certificateNo: stored.certificateNo })
    expect(JSON.stringify(c)).not.toMatch(/email|answers|certToken/)
  })

  it('mails nothing for a fail, and says when mail is not set up', async () => {
    const { mail, out } = mailer()
    await submitQuiz(engine, { token: TOKEN, body: fail, mail, origin })
    expect(out).toEqual([])
    const r = await submitQuiz(engine, { token: TOKEN, body: pass, mail: null, origin })
    expect(r.result.certificateEmail).toBe('unavailable')
  })

  it('records a mail that did not go', async () => {
    const { mail } = mailer(false)
    await submitQuiz(engine, { token: TOKEN, body: pass, mail, origin })
    const [stored] = await engine.list(null, 'quizResponses', {})
    expect(stored.certificateEmailError).toBe('not-sent')
  })

  it('opens no certificate for a fail, a guess or a malformed link', async () => {
    await submitQuiz(engine, { token: TOKEN, body: fail })
    for (const token of ['', 'x', 'a'.repeat(36), '../quizResponses']) {
      expect((await quizCertificate(engine, { token })).ok, token).toBe(false)
    }
  })

  it('lets a manager send it again to a corrected address, on a new link', async () => {
    await engine.commit(null, [
      { type: 'set', path: 'users', id: 'mgr', merge: false, data: { role: 'manager', status: 'approved' } },
      { type: 'set', path: 'users', id: 'emp', merge: false, data: { role: 'member', status: 'approved' } },
    ])
    const first = mailer()
    await submitQuiz(engine, { token: TOKEN, body: { ...pass, email: 'asha@wrong.example' }, mail: first.mail, origin })
    const [stored] = await engine.list(null, 'quizResponses', {})
    const oldToken = stored.certToken
    const again = mailer()
    // Not an employee, not without mail, not a bad address.
    expect(await resendQuizCertificate(engine, { uid: 'emp', responseId: stored.id, mail: again.mail, origin })).toMatchObject({ ok: false, reason: 'not-manager' })
    expect(await resendQuizCertificate(engine, { uid: 'mgr', responseId: stored.id, mail: null, origin })).toMatchObject({ ok: false, reason: 'no-mail' })
    expect(await resendQuizCertificate(engine, { uid: 'mgr', responseId: stored.id, email: 'nope', mail: again.mail, origin })).toMatchObject({ ok: false, reason: 'email' })
    const r = await resendQuizCertificate(engine, { uid: 'mgr', responseId: stored.id, email: 'asha@example.com', mail: again.mail, origin })
    expect(r).toEqual({ ok: true, sent: true, email: 'asha@example.com' })
    expect(again.out[0].to).toBe('asha@example.com')
    const now = await engine.get(null, 'quizResponses', stored.id)
    expect(now).toMatchObject({ email: 'asha@example.com', certificateReissuedBy: 'mgr' })
    expect(now.certToken).not.toBe(oldToken)
    // The link that went to the wrong address no longer opens anything.
    expect((await quizCertificate(engine, { token: oldToken })).ok).toBe(false)
    expect((await quizCertificate(engine, { token: now.certToken })).ok).toBe(true)
  })
})

