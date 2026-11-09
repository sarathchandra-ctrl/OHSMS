import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpPostgresAdapter, DATA_REQUEST_TIMEOUT_MS } from './postgres'

const response = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('HTTP subscription polling', () => {
  it('coalesces slow polls and delivers one fresh read after the pending one', async () => {
    vi.useFakeTimers()
    const pending = []
    const fetch = vi.fn(() => new Promise((resolve) => pending.push(resolve)))
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpPostgresAdapter('https://ehs.example.com')
    const next = vi.fn()
    const stop = adapter.subscribeDoc('settings', 'entitlements', next)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    pending[0](response({ doc: { id: 'entitlements', version: 1 } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(next).toHaveBeenLastCalledWith({ id: 'entitlements', version: 1 })
    stop()
    pending[1](response({ doc: { id: 'entitlements', version: 2 } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(next).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reports a stalled settings request so the error callback can release the module loader', async () => {
    vi.useFakeTimers()
    const pending = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, { signal }) =>
          new Promise((resolve, reject) => {
            pending.push(resolve)
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
          })
      )
    )
    const adapter = createHttpPostgresAdapter('https://ehs.example.com')
    const onError = vi.fn()
    const stop = adapter.subscribeDoc('settings', 'entitlements', vi.fn(), onError)
    await vi.advanceTimersByTimeAsync(DATA_REQUEST_TIMEOUT_MS)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].code).toBe('deadline-exceeded')
    stop()
    for (const resolve of pending) resolve(response({ doc: null }))
    await vi.advanceTimersByTimeAsync(0)
  })

  it('refreshes a subscription after a write during a pending read', async () => {
    vi.useFakeTimers()
    const reads = []
    const fetch = vi.fn((_url, init) => {
      const body = JSON.parse(init.body)
      if (body.op === 'commit') return Promise.resolve(response({ ok: true }))
      return new Promise((resolve) => reads.push(resolve))
    })
    vi.stubGlobal('fetch', fetch)
    const adapter = createHttpPostgresAdapter('https://ehs.example.com')
    const next = vi.fn()
    const stop = adapter.subscribeDoc('settings', 'entitlements', next)
    await vi.advanceTimersByTimeAsync(0)
    await adapter.set('settings', 'entitlements', { modules: { equipment: false } })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toHaveLength(1)
    reads[0](response({ doc: { id: 'entitlements', modules: { equipment: true } } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toHaveLength(2)
    reads[1](response({ doc: { id: 'entitlements', modules: { equipment: false } } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(next).toHaveBeenLastCalledWith({ id: 'entitlements', modules: { equipment: false } })
    stop()
  })
})
