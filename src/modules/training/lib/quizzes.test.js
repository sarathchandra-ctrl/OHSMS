import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../shared/data/client.js', () => ({}))
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../../../shared/org/orgData', () => ({ logAudit: vi.fn() }))

const { cleanQuiz, newQuizToken, quizProblems, responsesCsv } = await import('./quizzes')

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
    expect(csv).toContain("'=1+1")
    expect(csv).toContain("'@cmd")
    expect(csv).toContain('"A, B"')
    expect(csv).toContain('Pass')
  })
})
