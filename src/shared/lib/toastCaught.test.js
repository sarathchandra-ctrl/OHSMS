import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('react-hot-toast', () => ({ default: { error: (...a) => toastError(...a) } }))

const { toastCaught } = await import('./toastCaught')
const { setViewOnly, VIEW_ONLY_MESSAGE } = await import('../auth/viewOnly')

beforeEach(() => {
  toastError.mockClear()
  setViewOnly(false)
})

describe('toastCaught', () => {
  it('stays quiet on a permission refusal', () => {
    toastCaught({ code: 'permission-denied', message: 'Missing or insufficient permissions.' })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('still reports a real fault', () => {
    toastCaught({ code: 'unavailable' }, 'Could not save')
    expect(toastError).toHaveBeenCalled()
    expect(toastError.mock.calls[0][0]).toMatch(/connection dropped/i)
  })

  it('tells a view-only role why its change did not happen', () => {
    setViewOnly(true)
    toastCaught({ code: 'permission-denied', message: 'Missing or insufficient permissions.' })
    expect(toastError).toHaveBeenCalledWith(VIEW_ONLY_MESSAGE, { id: 'view-only' })
  })
})
