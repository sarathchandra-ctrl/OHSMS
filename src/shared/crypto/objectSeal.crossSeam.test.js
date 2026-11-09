// ─────────────────────────────────────────────────────────────────────────────
// The server seals an object; the client opens it. And the reverse.
//
// This file exists because functions/ and src/ are separate deployable packages
// that cannot import from each other, so the object backfill had to duplicate
// four things the client already knows: the AAD format string, the per-class
// file label, the two scheme tags, and the pointer field names.
//
// Everywhere else in this codebase that duplication is held together by a
// comment asking the next person to change both copies — MEDICAL_FIELDS, REGION,
// MEDICAL_RECORD_KIND. Those comments are load-bearing and they are not enough
// here, because the failure they would let through is not a bug that shows up in
// a test: it is a bucket full of objects that nothing can ever open again,
// discovered months later, with the plaintext long deleted.
//
// So this is the only test in the project that imports across the package seam,
// deliberately. It seals with the SERVER code and opens with the CLIENT code, in
// both key classes. If the two ever disagree about a single byte of the AAD, a
// label, a scheme tag or a field name, it goes red here rather than silently in
// production.
//
// It lives in src/ rather than functions/ because the root vitest config is the
// one that can resolve both sides.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'

// The client half — the code that will actually read these objects.
import {
  generateWrapKeyPair,
  importKey,
  importWrapPrivateKey,
  openBytes,
  sealBytes,
  sealHybridBytes,
  importWrapPublicKey,
  toB64u,
  fromB64u,
} from './envelope'
import { fileLabel as clientFileLabel, GENERAL, MEDICAL } from './policy'

// The server half.
import {
  sealObjectBytes,
  openObjectBytes,
  fileLabel as serverFileLabel,
  sealedPath,
  needsObjectSealing,
  sameBytes,
  pointerUpdate,
  FILE_TARGETS,
  SEALED_SUFFIX,
} from '../../../stack/lib/objectSeal.js'

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 200, 0, 255])

const pair = await generateWrapKeyPair()
const generalRaw = new Uint8Array(32).fill(9)

// What the callable unwraps the org keyset into, server-side.
const serverKeys = {
  general: { keyId: 'general.1', key: generalRaw },
  medical: {
    keyId: 'medical.1',
    publicKey: fromB64u(pair.publicKey),
    privateKey: fromB64u(pair.privateKey),
  },
}

// What the keyring holds, client-side.
const clientGeneral = await importKey(generalRaw)
const clientPrivate = await importWrapPrivateKey(pair.privateKey)
const clientPublic = await importWrapPublicKey(pair.publicKey)

describe('the constants both sides duplicate', () => {
  it('agrees on the file label for every key class', () => {
    // One character apart and every object sealed by the server fails its
    // authentication tag on the client, permanently.
    expect(serverFileLabel(GENERAL)).toBe(clientFileLabel(GENERAL))
    expect(serverFileLabel(MEDICAL)).toBe(clientFileLabel(MEDICAL))
    expect(serverFileLabel(MEDICAL)).toBe('file:medical')
  })

  it('covers exactly the collections the policy seals files for', async () => {
    // A collection given files:true in the policy and forgotten in FILE_TARGETS
    // would seal its new uploads and never seal its history — silently.
    const { POLICY, sealsFiles } = await import('./policy')
    const policySide = Object.keys(POLICY).filter(sealsFiles).sort()
    const serverSide = FILE_TARGETS.map((t) => t.collection).sort()
    expect(serverSide).toEqual(policySide)
  })

  it('assigns each collection the same key class the policy does', async () => {
    const { POLICY } = await import('./policy')
    for (const t of FILE_TARGETS) {
      expect(t.keyClass, `${t.collection} disagrees about its key class`).toBe(POLICY[t.collection].keyClass)
    }
  })
})

describe('server seals, client opens', () => {
  it('round-trips a general-class object', async () => {
    const sealed = await sealObjectBytes(serverKeys, GENERAL, PDF)
    const opened = await openBytes(
      clientGeneral, clientFileLabel(GENERAL),
      { scheme: sealed.encScheme, iv: sealed.encIv }, sealed.bytes,
    )
    expect(Array.from(opened)).toEqual(Array.from(PDF))
  })

  it('round-trips a medical-class object', async () => {
    const sealed = await sealObjectBytes(serverKeys, MEDICAL, PDF)
    const opened = await openBytes(
      clientPrivate, clientFileLabel(MEDICAL),
      { scheme: sealed.encScheme, iv: sealed.encIv, wrapped: sealed.encWrapped }, sealed.bytes,
    )
    expect(Array.from(opened)).toEqual(Array.from(PDF))
  })

  it('produces the scheme tags the client parser expects', async () => {
    expect((await sealObjectBytes(serverKeys, GENERAL, PDF)).encScheme).toBe('enc')
    expect((await sealObjectBytes(serverKeys, MEDICAL, PDF)).encScheme).toBe('enk')
  })

  it('produces pointer fields under the names the client reads', async () => {
    // isSealedFile() tests encIv and encKeyId; fileUrl() reads encScheme and
    // encWrapped. A renamed field means the app treats a sealed object as
    // plaintext and hands ciphertext to an <img>.
    const update = pointerUpdate(await sealObjectBytes(serverKeys, MEDICAL, PDF), 'orgs/o/k/f.enc')
    expect(Object.keys(update).sort()).toEqual(
      ['encIv', 'encKeyId', 'encScheme', 'encWrapped', 'path', 'url'],
    )
    expect(update.encIv).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('clears the stored download URL rather than carrying it forward', async () => {
    // The old value is a permanent bearer link to the PLAINTEXT object. Sealing
    // the bytes while leaving that string on the document would confine the
    // file and leave the door.
    expect(pointerUpdate(await sealObjectBytes(serverKeys, GENERAL, PDF), 'p').url).toBe('')
  })
})

describe('client seals, server opens', () => {
  // The other direction matters because both write: the app seals new uploads,
  // this job seals the history, and a manager reads both without knowing which.
  it('round-trips a general-class object', async () => {
    const sealed = await sealBytes(clientGeneral, 'general.1', clientFileLabel(GENERAL), PDF)
    const opened = await openObjectBytes(serverKeys, GENERAL, { encScheme: 'enc', encIv: sealed.iv }, sealed.bytes)
    expect(Array.from(opened)).toEqual(Array.from(PDF))
  })

  it('round-trips a medical-class object', async () => {
    const sealed = await sealHybridBytes(clientPublic, 'medical.1', clientFileLabel(MEDICAL), PDF)
    const opened = await openObjectBytes(
      serverKeys, MEDICAL,
      { encScheme: 'enk', encIv: sealed.iv, encWrapped: sealed.wrapped }, sealed.bytes,
    )
    expect(Array.from(opened)).toEqual(Array.from(PDF))
  })
})

describe('what the binding refuses', () => {
  it('refuses an object replayed under the other key class', async () => {
    // The one binding the per-class label buys: a medical record's bytes moved
    // to a general-class collection stay shut.
    const sealed = await sealObjectBytes(serverKeys, MEDICAL, PDF)
    await expect(openBytes(
      clientPrivate, clientFileLabel(GENERAL),
      { scheme: 'enk', iv: sealed.encIv, wrapped: sealed.encWrapped }, sealed.bytes,
    )).rejects.toBeTruthy()
  })


  it('refuses a medical object to a reader holding only the general key', async () => {
    const sealed = await sealObjectBytes(serverKeys, MEDICAL, PDF)
    await expect(openBytes(
      clientGeneral, clientFileLabel(MEDICAL),
      { scheme: 'enk', iv: sealed.encIv, wrapped: sealed.encWrapped }, sealed.bytes,
    )).rejects.toBeTruthy()
  })
})

describe('sealedPath', () => {
  it('is deterministic, so an interrupted run resumes instead of duplicating', () => {
    const once = sealedPath('files/incident-photos/ab12-x.jpg')
    expect(once).toBe(`files/incident-photos/ab12-x.jpg${SEALED_SUFFIX}`)
    expect(sealedPath(once)).toBe(once)
  })


  it('refuses traversal and malformed paths', () => {
    expect(sealedPath('files/../other/k/x.jpg')).toBe(null)
    expect(sealedPath('files/x.jpg')).toBe(null)       // too few segments
    expect(sealedPath('files/k/sub/x.jpg')).toBe(null) // too many
    expect(sealedPath('')).toBe(null)
  })
})

describe('needsObjectSealing', () => {
  it('agrees with the client about what counts as sealed', () => {
    // isSealedFile() on the client tests encIv, so anything the app treats as
    // sealed is skipped here by construction.
    expect(needsObjectSealing({ path: 'files/k/x.jpg' })).toBe(true)
    expect(needsObjectSealing({ path: 'files/k/x.jpg', encIv: 'AAAAAAAAAAAAAAAA' })).toBe(false)
  })

  it('skips the inline fallback, which the FIELD policy owns', () => {
    // No path means the file lives base64 inside the document and is sealed as
    // a field. Two mechanisms; this one owns neither end of that.
    expect(needsObjectSealing({ dataUrl: 'data:image/png;base64,AAA' })).toBe(false)
    expect(needsObjectSealing({ path: '   ' })).toBe(false)
    expect(needsObjectSealing(null)).toBe(false)
  })
})

describe('sameBytes', () => {
  it('rejects a truncated download without walking it', () => {
    expect(sameBytes(PDF, PDF.slice(0, 4))).toBe(false)
  })
  it('rejects a single altered byte', () => {
    const other = Uint8Array.from(PDF)
    other[3] ^= 1
    expect(sameBytes(PDF, other)).toBe(false)
  })
  it('accepts an identical copy', () => {
    expect(sameBytes(PDF, Uint8Array.from(PDF))).toBe(true)
  })
  it('rejects nothing at all', () => {
    expect(sameBytes(null, PDF)).toBe(false)
    expect(sameBytes(PDF, undefined)).toBe(false)
  })
})

describe('base64url agrees across the seam', () => {
  it('encodes the same bytes to the same string', async () => {
    const { toB64u: serverB64u } = await import('../../../stack/lib/dataKeys.js')
    const bytes = new Uint8Array(300)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256
    expect(serverB64u(bytes)).toBe(toB64u(bytes))
  })
})
