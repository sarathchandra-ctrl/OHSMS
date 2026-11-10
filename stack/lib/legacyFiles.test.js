import { describe, expect, it } from 'vitest'
import { findLegacyUrls, isLegacyFileUrl, legacyCopyPath, rewriteLegacyUrls } from './legacyFiles.js'

const FB = 'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/orgs%2Fx%2Fphoto%201.jpg?alt=media&token=abc'

describe('legacy file links', () => {
  it('recognises Firebase Storage links only, and only over https', () => {
    expect(isLegacyFileUrl(FB)).toBe(true)
    expect(isLegacyFileUrl('https://demo.firebasestorage.app/o/a.jpg')).toBe(true)
    expect(isLegacyFileUrl('http://firebasestorage.googleapis.com/o/a')).toBe(false)
    // A look-alike host must not pass: the server fetches whatever passes.
    expect(isLegacyFileUrl('https://firebasestorage.googleapis.com.evil.test/a')).toBe(false)
    expect(isLegacyFileUrl('https://evil.test/?u=https://firebasestorage.googleapis.com/a')).toBe(false)
  })

  it('finds links anywhere in a record', () => {
    const found = findLegacyUrls({ photo: { url: FB }, list: [{ files: [FB] }], note: 'x' })
    expect(found.map((f) => f.path)).toEqual([['photo', 'url'], ['list', 0, 'files', 0]])
  })

  it('rewrites each link, and the old object path beside it', async () => {
    const path = await legacyCopyPath(FB, async () => 'f'.repeat(64))
    expect(path).toBe(`files/legacy/${'f'.repeat(32)}-photo_1.jpg`)
    const copies = new Map([[FB, { url: 'https://ehs.test/blob?x', path }]])
    const out = rewriteLegacyUrls(
      { photo: { url: FB, path: 'orgs/x/photo 1.jpg', name: 'a' }, kept: { url: 'https://ehs.test/other', path: 'files/a' } },
      copies
    )
    expect(out.photo).toEqual({ url: 'https://ehs.test/blob?x', path, name: 'a' })
    expect(out.kept).toEqual({ url: 'https://ehs.test/other', path: 'files/a' })
  })
})
