import { describe, expect, it } from 'vitest'
import { matchCreators } from './creatorBackfill'

const users = [
  { uid: 'u1', name: 'Asha Rao', email: 'asha@example.test' },
  { uid: 'u2', name: 'Ben Lee', email: 'ben@example.test' },
  { uid: 'u3', name: 'Ben Lee', email: 'ben.lee@example.test' },
]

describe('matchCreators', () => {
  it('matches a name or an email to exactly one person, ignoring case and spaces', () => {
    const r = matchCreators(
      [
        { id: 'm1', createdBy: 'Asha Rao' },
        { id: 'm2', createdBy: '  ASHA@example.test ' },
      ],
      users
    )
    expect(r.matched).toEqual([
      { id: 'm1', uid: 'u1' },
      { id: 'm2', uid: 'u1' },
    ])
  })

  // Two people share a name: picking one would hand them edit rights over
  // the other's minutes.
  it('never guesses between two people with the same name', () => {
    const r = matchCreators([{ id: 'm3', createdBy: 'Ben Lee' }], users)
    expect(r.matched).toEqual([])
    expect(r.ambiguous).toEqual(['Ben Lee'])
    // The email still tells them apart.
    expect(matchCreators([{ id: 'm4', createdBy: 'ben.lee@example.test' }], users).matched).toEqual([
      { id: 'm4', uid: 'u3' },
    ])
  })

  it('reports a name nobody has, and leaves rows that already carry a uid alone', () => {
    const r = matchCreators(
      [
        { id: 'm5', createdBy: 'Former Staff' },
        { id: 'm6', createdBy: '' },
        { id: 'm7', createdBy: 'Asha Rao', createdByUid: 'u9' },
      ],
      users
    )
    expect(r.unmatched).toEqual(['Former Staff', '(no name)'])
    expect(r.already).toBe(1)
    expect(r.matched).toEqual([])
  })
})
