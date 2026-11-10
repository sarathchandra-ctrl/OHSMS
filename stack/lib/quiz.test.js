import { describe, expect, it } from 'vitest'
import { QUIZ_PASS_PERCENT, certificateNo, publicQuizView, quizProblems, readSubmission, scoreQuiz } from './quiz.js'

const quiz = (n = 5) => ({
  title: 'Fire safety',
  questions: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, text: `Q${i}`, options: ['A', 'B', 'C'], answer: i % 3 })),
})
const right = (q) => q.questions.map((x) => x.answer)

describe('writing a quiz', () => {
  it('names every problem with a quiz before it is published', () => {
    expect(quizProblems(quiz())).toEqual([])
    const bad = quizProblems({ title: ' ', questions: [{ text: '', options: ['A'], answer: 3 }] })
    expect(bad).toEqual(expect.arrayContaining([
      'Give the quiz a title.',
      'Question 1 has no text.',
      'Question 1 needs between 2 and 6 options.',
      'Mark the correct option for question 1.',
    ]))
    expect(quizProblems({ title: 'T', questions: [] })).toContain('Add at least one question.')
  })
})

describe('the quiz page', () => {
  it('shows the questions and options, never the answer key', () => {
    const view = publicQuizView({ ...quiz(2), questions: quiz(2).questions.map((q) => ({ ...q, explanation: 'x' })) })
    expect(JSON.stringify(view)).not.toMatch(/answer|explanation/)
    expect(view.questions[0]).toEqual({ id: 'q0', text: 'Q0', options: ['A', 'B', 'C'] })
    expect(view.passPercent).toBe(QUIZ_PASS_PERCENT)
  })
})

describe('a submission', () => {
  const body = (q, answers = right(q)) => ({ employeeId: ' E-17 ', name: 'Asha  Rao', centerName: 'Koramangala', answers })

  it('needs the taker’s details and one valid option per question', () => {
    const q = quiz(3)
    expect(readSubmission(q, body(q))).toMatchObject({ ok: true, taker: { employeeId: 'E-17', name: 'Asha Rao' } })
    expect(readSubmission(q, { ...body(q), employeeId: '' }).reason).toBe('employee-id')
    expect(readSubmission(q, { ...body(q), name: '  ' }).reason).toBe('name')
    expect(readSubmission(q, { ...body(q), centerName: '' }).reason).toBe('center')
    for (const answers of [[0, 1], [0, 1, 2, 0], [0, 1, 9], [0, 1, '2'], [0, 1, 1.5], 'all', null]) {
      expect(readSubmission(q, body(q, answers)).reason, JSON.stringify(answers)).toBe('answers')
    }
  })

  it('passes at exactly 80%, rounding down, and fails below it', () => {
    const q = quiz(5)
    const four = right(q).map((a, i) => (i === 0 ? (a + 1) % 3 : a))
    expect(scoreQuiz(q, four)).toEqual({ score: 4, total: 5, percent: 80, passed: true })
    const q9 = quiz(9)
    const seven = right(q9).map((a, i) => (i < 2 ? (a + 1) % 3 : a))
    expect(scoreQuiz(q9, seven)).toEqual({ score: 7, total: 9, percent: 77, passed: false })
    expect(scoreQuiz({ questions: [] }, [])).toMatchObject({ passed: false })
  })

  it('numbers a certificate from its response', () => {
    expect(certificateNo('abcdef12-3456')).toBe('CFSMS-QZ-ABCDEF12')
  })
})
