import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { applySchema, createEngine } from './engine.mjs'
import { publicQuiz, submitQuiz } from './quiz.mjs'

let engine
const TOKEN = 'quiztoken1234567ab'
const questions = [
  { id: 'q1', text: 'Extinguisher for electrical fire?', options: ['Water', 'CO2', 'Foam'], answer: 1 },
  { id: 'q2', text: 'Assembly point?', options: ['Car park', 'Roof'], answer: 0 },
  { id: 'q3', text: 'Call first?', options: ['Security', 'Friend'], answer: 0 },
  { id: 'q4', text: 'Lift in a fire?', options: ['Use it', 'Never'], answer: 1 },
  { id: 'q5', text: 'Blocked exit?', options: ['Report it', 'Ignore'], answer: 0 },
]
const taker = { employeeId: 'E-17', name: 'Asha Rao', centerName: 'Koramangala' }

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
