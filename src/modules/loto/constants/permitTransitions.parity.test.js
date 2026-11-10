import { describe, expect, it } from 'vitest'
import { PERMIT_TRANSITIONS, PERMIT_STATUS } from './permits'
import { LOTO_TRANSITIONS } from '../../../../stack/policy.mjs'

// Two copies of one table in two packages: the buttons (here) and the server
// policy. A move one allows and the other refuses is either a button that
// always fails or, worse, a step the server would take that nobody sees.
describe('LOTO permit transitions', () => {
  it('match the server policy exactly', () => {
    const sorted = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v].sort()]))
    expect(sorted(PERMIT_TRANSITIONS)).toEqual(sorted(LOTO_TRANSITIONS))
    expect(Object.keys(LOTO_TRANSITIONS).sort()).toEqual(Object.values(PERMIT_STATUS).sort())
  })
})
