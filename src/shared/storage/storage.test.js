// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  safeFileName, storagePath, dataUrlToBlob,
  MAX_UPLOAD_BYTES, MAX_INLINE_BYTES, formatSize, tooLargeForInline,
  fileUrl, putFile, RejectedFileError,
} from './index'

// Two limits, and the relationship between them is the whole point: the big one
// is a product decision, the small one is a hard Firestore constraint. If these
// ever cross, uploads start failing with an error nobody can act on.
describe('upload limits', () => {
  it('accepts 10MB uploads, which is what the UI promises', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
    expect(formatSize(MAX_UPLOAD_BYTES)).toBe('10.0 MB')
  })

  it('keeps the inline fallback under what a Firestore document can hold', () => {
    // Base64 inflates by ~4/3, and the document needs room for its own fields.
    const encoded = MAX_INLINE_BYTES * (4 / 3)
    expect(encoded).toBeLessThan(1024 * 1024)
  })

  it('never lets the fallback limit exceed the upload limit', () => {
    expect(MAX_INLINE_BYTES).toBeLessThan(MAX_UPLOAD_BYTES)
  })

  it('explains both the constraint and the fix when a file is too big to inline', () => {
    const msg = tooLargeForInline('site-photo.jpg')
    expect(msg).toContain('site-photo.jpg')
    expect(msg).toContain(formatSize(MAX_INLINE_BYTES))  // what is allowed now
    expect(msg).toContain(formatSize(MAX_UPLOAD_BYTES))  // what enabling storage buys
    expect(msg).toMatch(/Cloud Storage/)
  })

  it('reads sizes the way a person would write them', () => {
    expect(formatSize(700 * 1024)).toBe('700 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(0)).toBe('0 KB')
  })
})

describe('safeFileName', () => {
  it('keeps an ordinary filename readable', () => {
    expect(safeFileName('Fire Safety SOP v2.pdf')).toBe('Fire Safety SOP v2.pdf')
  })

  it('strips path separators and URL-hostile characters', () => {
    // A filename must never be able to climb the path or smuggle a query.
    expect(safeFileName('../../etc/passwd')).not.toContain('/')
    expect(safeFileName('a?b#c%d[e]f{g}h')).not.toMatch(/[?#%[\]{}]/)
  })

  it('never returns empty, whatever it is given', () => {
    for (const bad of ['', null, undefined, '///', '???']) {
      expect(safeFileName(bad).length).toBeGreaterThan(0)
    }
  })

  it('caps length so a pasted essay cannot become a path segment', () => {
    expect(safeFileName('x'.repeat(500)).length).toBeLessThanOrEqual(120)
  })
})

describe('storagePath', () => {
  const fixed = () => 'abcd1234'

  it('files everything under files/<kind>/ — the only prefix the server signs', () => {
    expect(storagePath('training-content', 'a.pdf', fixed)).toBe(
      'files/training-content/abcd1234-a.pdf'
    )
  })

  it('two identical filenames get different paths', () => {
    const a = storagePath('k', 'photo.jpg')
    const b = storagePath('k', 'photo.jpg')
    expect(a).not.toBe(b)
  })

  it('refuses to build a path with no kind', () => {
    expect(() => storagePath('', 'a')).toThrow()
  })

  it('sanitises every segment, not only the filename', () => {
    const p = storagePath('kind/../x', 'a.pdf', () => 'r')
    expect(p).toBe('files/kind____x/r-a.pdf')
    expect(p.split('/').length).toBe(3)
  })

  it('refuses a segment that sanitises to nothing', () => {
    expect(() => storagePath('???', 'a')).toThrow()
  })
})

// jsdom's Blob has no .text(); FileReader is the reader it does implement.
const readBlob = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(r.result)
  r.onerror = reject
  r.readAsText(blob)
})

describe('dataUrlToBlob', () => {
  it('round-trips a base64 data URL with its content type', async () => {
    const blob = dataUrlToBlob('data:text/plain;base64,aGVsbG8=')
    expect(blob.type).toBe('text/plain')
    expect(await readBlob(blob)).toBe('hello')
  })

  it('handles the URL-encoded (non-base64) form', async () => {
    const blob = dataUrlToBlob('data:text/plain,hello%20world')
    expect(await readBlob(blob)).toBe('hello world')
  })

  it('defaults the content type rather than inventing one', () => {
    expect(dataUrlToBlob('data:;base64,aGk=').type).toBe('application/octet-stream')
  })

  it('returns null for anything that is not a data URL', () => {
    for (const bad of ['https://x/y.png', 'hello', '', null, 'data:text/plain;base64,%%%']) {
      expect(dataUrlToBlob(bad)).toBeNull()
    }
  })
})

// A persisted download URL is a bearer credential in a string: it works for
// anyone holding it, signed in or not, forever, and storage.rules never sees
// it. fileUrl exists to prefer an authenticated fetch over that — while never
// letting the secure path turn a working image into a broken one.
// 20s, not the 5s default: every case here awaits loadAdapter(), which is a
// DYNAMIC import. Alone it resolves in well under a second; inside a full run
// competing with 80 other files it does not, and the suite went red for a
// reason that had nothing to do with the behaviour under test.
describe('resolving a stored file to a governed URL', { timeout: 20000 }, () => {
  const STORED = 'https://firebasestorage.googleapis.com/o/x?alt=media&token=perm'

  it('falls back to the stored URL when the record predates paths', async () => {
    const r = await fileUrl({ url: STORED })
    expect(r.url).toBe(STORED)
    expect(() => r.revoke()).not.toThrow()
  })

  // The bucket needs a CORS rule for getBlob that <img src> never required.
  // Until that lands the adapter returns null, and the app must keep rendering.
  it('falls back when the authenticated fetch cannot succeed', async () => {
    const r = await fileUrl({ url: STORED, path: 'orgs/a/incidents/p.jpg' })
    expect(r.url).toBe(STORED)
  })

  it('has nothing to offer when there is neither a path nor a URL', async () => {
    const r = await fileUrl({})
    expect(r.url).toBeNull()
    expect(await (await fileUrl(null)).url).toBeNull()
  })

  // Every caller gets a revoke, so no caller has to test whether it needs one.
  it('always returns a callable revoke', async () => {
    for (const rec of [{ url: STORED }, {}, 'orgs/a/x.jpg']) {
      expect(typeof (await fileUrl(rec)).revoke).toBe('function')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A file refused on its CONTENTS must not degrade to the inline fallback.
//
// putFile returns null for every infrastructure failure — no driver, offline,
// rules refusal — and every caller answers that by writing the bytes base64
// into a Firestore document instead. For a file refused because it is an
// executable wearing a document's name, that fallback would store precisely
// what was just refused, and the check would have achieved nothing.
//
// So the refusal is a distinct error type that propagates. This asserts the
// distinction rather than the sniffing itself, which is sniffType.test.js.
// ─────────────────────────────────────────────────────────────────────────────
describe('a refused file does not fall back to inline storage', () => {
  it('throws RejectedFileError rather than returning null', async () => {
    // MZ — a Windows executable — declared as a PDF.
    const exe = new Blob([Uint8Array.from([0x4d, 0x5a, 0x90, 0x00])], { type: 'application/pdf' })
    await expect(putFile('permit-documents', exe, 'report.pdf'))
      .rejects.toThrow(RejectedFileError)
  })

  it('gives the person a reason they can act on', async () => {
    const exe = new Blob([Uint8Array.from([0x4d, 0x5a, 0x90, 0x00])], { type: 'application/pdf' })
    await expect(putFile('permit-documents', exe, 'report.pdf'))
      .rejects.toThrow(/Windows executable/)
  })

  // The distinction that matters: null still means "storage is unavailable,
  // use the inline path", and that behaviour is unchanged for everything else.
  it('still returns null when there is no driver, rather than throwing', async () => {
    const ok = new Blob([Uint8Array.from([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' })
    // No emulator/bucket configured in this environment, so the adapter cannot
    // upload — the infrastructure path, which must stay non-fatal.
    await expect(putFile('permit-documents', ok, 'real.pdf')).resolves.toBeNull()
  })
})
