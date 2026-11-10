import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../shared/data/client.js', () => ({}))
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../../../shared/org/orgData', () => ({ logAudit: vi.fn() }))

const { cleanQuiz, newQuizToken, quizProblems, quizResultTable, quizResultsCsv, responseAnswers, responsesCsv } = await import('./quizzes')

describe('quiz helpers', () => {
  it('stores trimmed text and an option index for the answer', () => {
    const q = cleanQuiz({ title: '  Fire  ', questions: [{ id: 'a', text: ' Q ', options: [' A ', 'B'], answer: 1 }] })
    expect(q).toEqual({ title: 'Fire', description: '', questions: [{ id: 'a', text: 'Q', options: ['A', 'B'], answer: 1 }] })
    expect(quizProblems(cleanQuiz({ title: 'T', questions: [{ text: 'Q', options: ['A', 'B'], answer: null }] })))
      .toContain('Mark the correct option for question 1.')
  })

  it('makes a token the server accepts', () => {
    expect(newQuizToken()).toMatch(/^[0-9a-z]{8,64}$/)
  })

  // Names and centres are typed by whoever scanned the code.
  it('exports results without letting a typed formula run in a spreadsheet', () => {
    const csv = responsesCsv([{ quizTitle: 'Fire', employeeId: '=1+1', name: '@cmd', centerName: 'A, B', score: 4, total: 5, percent: 80, passed: true, certificateNo: 'C1' }])
    // shared/lib/csv: a leading tab, so the cell is text, never a formula.
    expect(csv).toContain('"\t=1+1"')
    expect(csv).toContain('"\t@cmd"')
    expect(csv).toContain('"A, B"')
    expect(csv).toContain('Pass')
  })

  const quiz = { title: 'Fire', questions: [
    { text: 'Extinguisher?', options: ['Water', 'CO2'], answer: 1 },
    { text: 'Lift?', options: ['Yes', 'Never'], answer: 1 },
  ] }

  it('reads what a person answered from the response, else against the quiz', () => {
    const stored = [{ question: 'Extinguisher? (old wording)', chosen: 'CO2', correct: true }]
    expect(responseAnswers({ answerDetail: stored }, quiz)).toBe(stored)
    expect(responseAnswers({ answers: [0, 1] }, quiz)).toEqual([
      { question: 'Extinguisher?', chosen: 'Water', correct: false },
      { question: 'Lift?', chosen: 'Never', correct: true },
    ])
  })

  it('lays one quiz out a row per person and a column per question', () => {
    const r = { submittedAt: '2026-11-10T09:30:00.000Z', employeeId: 'E-1', name: 'Asha', centerName: 'HSR', score: 1, total: 2, percent: 50, passed: false, answers: [0, 1] }
    const { header, rows } = quizResultTable(quiz, [r])
    expect(header.slice(-2)).toEqual(['Q1. Extinguisher?', 'Q2. Lift?'])
    expect(rows[0].slice(1, 4)).toEqual(['E-1', 'Asha', 'HSR'])
    expect(rows[0].slice(-2)).toEqual(['Water (wrong)', 'Never (correct)'])
    expect(rows[0][0]).toMatch(/2026/)
    expect(quizResultsCsv(quiz, [r]).split('\r\n')).toHaveLength(2)
  })
})
