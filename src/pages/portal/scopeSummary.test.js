import { describe, expect, it } from 'vitest'
import { scopeSummary } from './scopeSummary'

describe('scopeSummary', () => {
  // The line listed every visible site by name; it must say "All …" instead.
  it('says All for each level when nothing is narrowed', () => {
    expect(scopeSummary({ region: 'all', entity: 'all' })).toEqual([
      ['Regions', 'All regions'],
      ['Entities', 'All entities'],
      ['Sites', 'All sites'],
    ])
  })

  it('names only what was picked', () => {
    expect(scopeSummary({ region: 'South', entity: 'all', siteName: 'Site A' })).toEqual([
      ['Regions', 'South'],
      ['Entities', 'All entities'],
      ['Sites', 'Site A'],
    ])
  })

  // An empty pick is not a name to show.
  it('falls back to All for empty values', () => {
    expect(scopeSummary({ region: '', entity: undefined, siteName: '' })).toEqual([
      ['Regions', 'All regions'],
      ['Entities', 'All entities'],
      ['Sites', 'All sites'],
    ])
  })
})
