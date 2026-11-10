import { describe, expect, it } from 'vitest'
import { closeBlocker, openActions } from './openActions'

describe('closing with open actions', () => {
  it('counts every action that is not closed, a missing status as open', () => {
    expect(openActions([{ status: 'closed' }, { status: 'in_progress' }, {}, null])).toHaveLength(2)
  })
  it('says what is in the way, and nothing when all are closed', () => {
    expect(closeBlocker([{ status: 'open' }])).toBe(
      '1 corrective action is still open. Close it before closing the incident.'
    )
    expect(closeBlocker([{ status: 'open' }, {}], 'illness report')).toMatch(/2 corrective actions are still open/)
    expect(closeBlocker([{ status: 'closed' }])).toBe('')
    expect(closeBlocker(undefined)).toBe('')
  })
})
