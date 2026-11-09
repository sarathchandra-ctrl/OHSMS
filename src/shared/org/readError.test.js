import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const currentUser = { value: null }
vi.mock('../db', () => ({
  auth: {
    get currentUser() {
      return currentUser.value
    },
  },
}))

const { onReadError } = await import('./readError')

let warn
let debug
beforeEach(() => {
  currentUser.value = { uid: 'u1' }
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  debug.mockRestore()
})

describe('onReadError', () => {
  it('unblocks the caller with an empty list', () => {
    // The whole point. Every module context clears `loading` from the success
    // callback, so a listener with no error branch is a permanent spinner.
    const cb = vi.fn()
    onReadError('incidents', cb)(new Error('index missing'))
    expect(cb).toHaveBeenCalledWith([])
  })

  it('hands back whatever fallback the caller needs', () => {
    const cb = vi.fn()
    onReadError('the org', cb, null)(new Error('nope'))
    expect(cb).toHaveBeenCalledWith(null)
  })

  it('reports a real fault loudly', () => {
    onReadError('incidents', vi.fn())(new Error('The query requires an index'))
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0][0]).toContain('incidents')
  })

  it('names the failure, not just the collection', () => {
    onReadError('permits', vi.fn())({ message: 'The query requires an index' })
    expect(warn.mock.calls[0][1]).toContain('index')
  })

  it('stays quiet when the session simply ended', () => {
    // Signing out refuses every open listener at once. Ten "read failed"
    // warnings on the way out of a normal sign-out teaches people to scroll
    // past the message that matters.
    currentUser.value = null
    onReadError('incidents', vi.fn())({ code: 'permission-denied' })
    expect(warn).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalled()
  })

  it('STILL unblocks the caller on a sign-out error', () => {
    // Quiet is about the log, never about the callback: a screen left loading
    // forever is the defect either way.
    currentUser.value = null
    const cb = vi.fn()
    onReadError('incidents', cb)({ code: 'permission-denied' })
    expect(cb).toHaveBeenCalledWith([])
  })

  it('stays quiet on permission-denied with a live session — that is an access check', () => {
    onReadError('injuries', vi.fn())({ code: 'permission-denied' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('survives an error with no message at all', () => {
    const cb = vi.fn()
    expect(() => onReadError('x', cb)(undefined)).not.toThrow()
    expect(cb).toHaveBeenCalledWith([])
  })
})
