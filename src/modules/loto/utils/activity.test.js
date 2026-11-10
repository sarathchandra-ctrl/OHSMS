import { describe, expect, it } from 'vitest'
import { filterActivity, toMs } from './activity'

const NOW = Date.parse('2026-11-10T08:00:00.000Z')

describe('the activity log', () => {
  it('filters by search and by action', () => {
    const events = [
      { action: 'lock', byName: 'Asha', at: NOW, permitNo: 'LP-1' },
      { action: 'unlock', byName: 'Ben', at: NOW - 1, permitNo: 'LP-2' },
    ]
    expect(filterActivity(events, { q: 'asha' })).toHaveLength(1)
    expect(filterActivity(events, { q: 'lp-2' })).toHaveLength(1)
    expect(filterActivity(events, { action: 'unlock' })).toHaveLength(1)
    expect(filterActivity(events, { fromMs: NOW })).toHaveLength(1)
  })

  it('reads the timestamp shapes the store and JSON hand over', () => {
    expect(toMs(5)).toBe(5)
    expect(toMs(new Date(7))).toBe(7)
    expect(toMs({ toMillis: () => 9 })).toBe(9)
    expect(toMs({ seconds: 2, nanoseconds: 5e6 })).toBe(2005)
    expect(toMs('2026-10-05T00:00:00.000Z')).toBe(Date.parse('2026-10-05T00:00:00.000Z'))
    expect(toMs('')).toBeNaN()
  })
})
