import { describe, it, expect, beforeEach, vi } from 'vitest'

const calls = vi.hoisted(() => ({ fetched: [], revoked: 0 }))

// fileUrl is the thing under everything here; what matters is that it is called
// only for sealed rows, and that every revoke it hands back is eventually run.
vi.mock('./index', () => ({
  fileUrl: async (record) => {
    calls.fetched.push(record.path)
    if (record.path === 'boom') throw new Error('denied')
    if (record.path === 'nokey') return { url: null, revoke: () => {}, restricted: true }
    return { url: `blob:${record.path}`, revoke: () => { calls.revoked += 1 } }
  },
}))

const { resolveSealedFiles, resolveSubscription } = await import('./resolveFiles')

const COL = 'incidents/photos'

const sealed = (path) => ({
  id: path, path, url: `https://bucket/${path}`, dataUrl: `https://bucket/${path}`,
  encScheme: 'enc', encKeyId: 'general.1', encIv: 'AAAAAAAAAAAAAAAA',
})
const plain = (path) => ({ id: path, path, url: `https://bucket/${path}`, dataUrl: `https://bucket/${path}` })

const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }

beforeEach(() => { calls.fetched = []; calls.revoked = 0 })

describe('resolveSealedFiles', () => {
  it('leaves an unsealed list completely alone', async () => {
    // The path every existing gallery takes until something is uploaded under a
    // sealed policy: no fetch, no allocation, same array back.
    const rows = [plain('a'), plain('b')]
    const out = await resolveSealedFiles(COL, rows)
    expect(out.rows).toBe(rows)
    expect(calls.fetched).toEqual([])
  })

  it('resolves a sealed row onto the same field the renderers read', async () => {
    // .dataUrl is the one field every gallery and all three PDFs read. If the
    // decrypted URL landed anywhere else, nothing would render.
    const out = await resolveSealedFiles(COL, [sealed('x')])
    expect(out.rows[0].dataUrl).toBe('blob:x')
  })

  it('fetches only the sealed rows in a mixed list', async () => {
    const out = await resolveSealedFiles(COL, [plain('a'), sealed('b'), plain('c')])
    expect(calls.fetched).toEqual(['b'])
    expect(out.rows[0].dataUrl).toBe('https://bucket/a')
    expect(out.rows[2].dataUrl).toBe('https://bucket/c')
  })

  it('does not mutate the rows it was given', async () => {
    const rows = [sealed('x')]
    await resolveSealedFiles(COL, rows)
    expect(rows[0].dataUrl).toBe('https://bucket/x')
  })

  it('releases every URL when revoked', async () => {
    const out = await resolveSealedFiles(COL, [sealed('a'), sealed('b'), sealed('c')])
    out.revoke()
    expect(calls.revoked).toBe(3)
  })

  it('reports a file it cannot open WITHOUT falling back to the stored URL', async () => {
    // That URL points at ciphertext. Falling back would render a broken image,
    // which reads to a manager as "the file is gone" rather than "you have no
    // key loaded".
    const out = await resolveSealedFiles(COL, [sealed('nokey')])
    expect(out.rows[0].dataUrl).toBe('')
    expect(out.rows[0].restricted).toBe(true)
  })

  it('lets one bad file through without taking the gallery down', async () => {
    const out = await resolveSealedFiles(COL, [sealed('boom'), sealed('ok')])
    expect(out.rows[0].restricted).toBe(true)
    expect(out.rows[1].dataUrl).toBe('blob:ok')
  })

  it('survives a missing org or a non-array', async () => {
    expect((await resolveSealedFiles(COL, [sealed('x')])).rows).toHaveLength(1)
    expect((await resolveSealedFiles(COL, null)).rows).toEqual([])
  })
})

describe('resolveSubscription', () => {
  it('delivers resolved rows to the callback', async () => {
    const cb = vi.fn()
    resolveSubscription(COL, cb)([sealed('a')])
    await settle()
    expect(cb.mock.calls.at(-1)[0][0].dataUrl).toBe('blob:a')
  })

  it('revokes the previous batch when a new snapshot arrives', async () => {
    // Without this a live gallery leaks every photo it has ever shown.
    const onRows = resolveSubscription(COL, vi.fn())
    onRows([sealed('a')])
    await settle()
    expect(calls.revoked).toBe(0)
    onRows([sealed('b')])
    await settle()
    expect(calls.revoked).toBe(1)
  })

  it('revokes the last batch when the listener stops', async () => {
    const onRows = resolveSubscription(COL, vi.fn())
    onRows([sealed('a'), sealed('b')])
    await settle()
    onRows.stop()
    expect(calls.revoked).toBe(2)
  })

  it('drops a stale batch AND revokes it', async () => {
    // Resolving is async and a busy collection re-emits faster than a gallery
    // decrypts, so two batches can finish in the wrong order. Dropping the
    // stale one without revoking would leak precisely the batches nobody sees.
    const cb = vi.fn()
    const onRows = resolveSubscription(COL, cb)
    onRows([sealed('old')])
    onRows([sealed('new')])
    await settle()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0][0].dataUrl).toBe('blob:new')
    expect(calls.revoked).toBe(1) // the stale batch's URL, released
  })

  it('delivers nothing after it has been stopped', async () => {
    const cb = vi.fn()
    const onRows = resolveSubscription(COL, cb)
    onRows.stop()
    onRows([sealed('a')])
    await settle()
    expect(cb).not.toHaveBeenCalled()
    expect(calls.revoked).toBe(1) // and the in-flight batch is not leaked
  })
})
