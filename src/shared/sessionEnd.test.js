import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { session } = vi.hoisted(() => ({ session: { token: '' } }))
vi.mock('./auth/ownStackSession', () => ({ currentAccessToken: () => session.token }))

const { isSessionEnd } = await import('./sessionEnd')

const denied = { code: 'permission-denied', message: 'Missing or insufficient permissions.' }

describe('isSessionEnd', () => {
  let debug
  beforeEach(() => {
    debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  })
  afterEach(() => debug.mockRestore())

  it('claims the refusals that arrive as a session ends', () => {
    session.token = ''
    expect(isSessionEnd('incidents', denied)).toBe(true)
    expect(debug).toHaveBeenCalledWith('[OHS MS] incidents listener closed with the session')
  })

  it('leaves a refusal alone while somebody is still signed in', () => {
    // The case worth keeping loud: a rule is wrong and a safety module is about
    // to show an empty list to someone who should be seeing rows.
    session.token = 'signed-in'
    expect(isSessionEnd('incidents', denied)).toBe(false)
    expect(debug).not.toHaveBeenCalled()
  })

  it('claims nothing that is not a refusal, signed out or not', () => {
    session.token = ''
    for (const err of [{ code: 'unavailable' }, { code: 'deadline-exceeded' }, new Error('boom'), null]) {
      expect(isSessionEnd('incidents', err)).toBe(false)
    }
    expect(debug).not.toHaveBeenCalled()
  })
})
