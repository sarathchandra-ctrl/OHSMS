import { describe, it, expect } from 'vitest'
import { isAppConfigured } from './appConfigured'

describe('isAppConfigured', () => {
  it('lets a build that knows its server through', () => {
    expect(isAppConfigured({ gateway: 'https://ehs.example.com' })).toBe(true)
  })

  it('stops a build that has no server to talk to', () => {
    expect(isAppConfigured({ gateway: '' })).toBe(false)
  })
})
