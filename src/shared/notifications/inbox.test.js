import { describe, expect, it } from 'vitest'
import { ago, safeLink } from './inbox'

describe('where a notification opens', () => {
  it('opens a path inside the app', () => {
    expect(safeLink('/incidents/i1')).toBe('/incidents/i1')
    expect(safeLink('/audit?view=auditee')).toBe('/audit?view=auditee')
  })

  it('never leaves the app, whatever the item says', () => {
    for (const bad of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '',
      null,
    ]) {
      expect(safeLink(bad), String(bad)).toBe('')
    }
  })
})

describe('when it arrived', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  it('reads as a short relative time, then a date', () => {
    expect(ago('2026-11-10T11:59:30Z', now)).toBe('just now')
    expect(ago('2026-11-10T11:55:00Z', now)).toBe('5 min ago')
    expect(ago('2026-11-10T09:00:00Z', now)).toBe('3 h ago')
    expect(ago('2026-11-08T12:00:00Z', now)).toBe('2 d ago')
    expect(ago('2026-10-01T12:00:00Z', now)).toBe('1 Oct 2026')
    expect(ago('nonsense', now)).toBe('')
  })
})
