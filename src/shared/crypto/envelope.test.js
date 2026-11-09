import { describe, it, expect } from 'vitest'
import {
  isEnvelope,
  parseEnvelope,
  importKey,
  sealValue,
  openValue,
  sealBytes,
  openBytes,
  toB64u,
  fromB64u,
  SealedValueError,
  KEY_BYTES,
  generateWrapKeyPair,
  importWrapPublicKey,
  importWrapPrivateKey,
  sealHybridValue,
  sealHybridBytes,
  hybridSealer,
} from './envelope'

const ORG = 'org-alpha'
const rawKey = (fill) => new Uint8Array(KEY_BYTES).fill(fill)

// Every test seals with a real key against the real WebCrypto in the test
// runtime. There is no fake: a stub that "encrypts" by reversing a string would
// pass every assertion below and prove nothing about the thing that ships.
const keyA = await importKey(rawKey(7))
const keyB = await importKey(rawKey(9))
const only = (id, key) => (asked) => (asked === id ? key : null)

describe('base64URL', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 255, 254, 127, 128, 65, 43, 47])
    expect(Array.from(fromB64u(toB64u(bytes)))).toEqual(Array.from(bytes))
  })

  it('emits no characters that need escaping elsewhere', () => {
    // 3000 bytes is enough to force every base64 alignment, including the two
    // that produce '+' and '/' in the standard alphabet.
    const bytes = new Uint8Array(3000)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256
    expect(toB64u(bytes)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('survives a payload past the fromCharCode argument limit', () => {
    // The chunking in toB64u exists for exactly this; without it a file-sized
    // buffer throws RangeError rather than encoding.
    const bytes = new Uint8Array(200_000).fill(200)
    expect(fromB64u(toB64u(bytes)).length).toBe(200_000)
  })
})

describe('the envelope format', () => {
  it('recognises what it produces', async () => {
    expect(isEnvelope(await sealValue(keyA, 'medical.1', 'medication', 'Ibuprofen'))).toBe(true)
  })

  it('refuses a prefix that only LOOKS like one', () => {
    // The whole reason isEnvelope is a shape test. If any of these passed,
    // sealValue would treat the typed text as already-sealed and store it
    // in the clear.
    expect(isEnvelope('enc:1:whatever')).toBe(false)
    expect(isEnvelope('enc:1:key:short:abc')).toBe(false)
    expect(isEnvelope('enc:2:medical.1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
    expect(isEnvelope('enc:1:med:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA!')).toBe(false)
  })

  it('is not confused by non-strings', () => {
    expect(isEnvelope(42)).toBe(false)
    expect(isEnvelope(null)).toBe(false)
    expect(isEnvelope(['enc:1:a:b:c'])).toBe(false)
    expect(parseEnvelope(42)).toBe(null)
  })

  it('names the key that sealed the value', async () => {
    const sealed = await sealValue(keyA, 'medical.3', 'medication', 'x')
    expect(parseEnvelope(sealed).keyId).toBe('medical.3')
  })

  it('refuses a key id that would corrupt the layout', async () => {
    // A colon in the id shifts every segment along; the value would parse back
    // wrong and be unreadable, and only for records written while it was live.
    await expect(sealValue(keyA, 'bad:id', 'medication', 'x')).rejects.toThrow(/Invalid key id/)
  })
})

describe('sealValue / openValue', () => {
  it('round-trips every type this app stores in an encrypted field', async () => {
    const cases = [
      'Ibuprofen 400mg',
      '',
      0,
      3,
      true,
      false,
      null,
      ['Left hand', 'Right forearm'],
      [],
      { description: 'Fell from step', owner: 'A Kumar' },
    ]
    for (const value of cases) {
      const sealed = await sealValue(keyA, 'k1', 'field', value)
      expect(await openValue(only('k1', keyA), 'field', sealed)).toEqual(value)
    }
  })

  it('restores the original TYPE, not a stringified copy', async () => {
    // The failure this guards against is silent: String(3) and String(['a'])
    // both read plausibly on screen and are the wrong value forever after.
    const n = await openValue(only('k1', keyA), 'days', await sealValue(keyA, 'k1', 'days', 3))
    expect(n).toBe(3)
    expect(typeof n).toBe('number')
    const a = await openValue(only('k1', keyA), 'parts', await sealValue(keyA, 'k1', 'parts', ['a']))
    expect(Array.isArray(a)).toBe(true)
  })

  it('leaves undefined alone rather than storing null', async () => {
    // An absent field and a field holding null are different clinical answers.
    expect(await sealValue(keyA, 'k1', 'medication', undefined)).toBe(undefined)
  })

  it('never emits the plaintext inside the ciphertext', async () => {
    const sealed = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    expect(sealed).not.toContain('Ibuprofen')
  })

  it('produces a different ciphertext every time for the same input', async () => {
    // A deterministic ciphertext leaks equality: an auditor who cannot read
    // `medication` could still see which two people were prescribed the same
    // thing. The random IV is what prevents it.
    const a = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    const b = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    expect(a).not.toBe(b)
  })

  it('is idempotent', async () => {
    // Read-modify-write is how every update in this app works, so a value
    // passes through sealValue once per save. Wrapping it again each time would
    // grow the document until Firestore refused it.
    const once = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    const twice = await sealValue(keyA, 'k1', 'medication', once)
    expect(twice).toBe(once)
  })
})

describe('what decryption refuses', () => {
  it('refuses a value moved to another field', async () => {
    // The attack the AAD exists for: one key covers the whole org, so without
    // this binding anyone who can write a widely-read field could paste a
    // medication ciphertext into it and have the app print it for them.
    const sealed = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    await expect(openValue(only('k1', keyA), 'narrative', sealed))
      .rejects.toMatchObject({ reason: 'corrupt' })
  })


  it('refuses a tampered ciphertext', async () => {
    const sealed = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    const flipped = `${sealed.slice(0, -2)}${sealed.slice(-2) === 'AA' ? 'AB' : 'AA'}`
    await expect(openValue(only('k1', keyA), 'medication', flipped))
      .rejects.toBeInstanceOf(SealedValueError)
  })

  it('refuses the wrong key', async () => {
    const sealed = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    await expect(openValue(only('k1', keyB), 'medication', sealed))
      .rejects.toMatchObject({ reason: 'corrupt' })
  })

  it('reports a withheld key as restricted, not as corruption', async () => {
    // This is the auditor reading an injury record, and it is a normal page
    // view — not something that should reach the error tracker.
    const sealed = await sealValue(keyA, 'medical.1', 'medication', 'Ibuprofen')
    await expect(openValue(() => null, 'medication', sealed))
      .rejects.toMatchObject({ reason: 'restricted' })
  })
})

describe('reading data that was never encrypted', () => {
  // The property the rollout depends on. Every collection holds a mixture for
  // as long as the backfill takes, and for whatever it declines to touch after.
  it('passes plaintext through untouched', async () => {
    const resolve = () => { throw new Error('must not ask for a key') }
    expect(await openValue(resolve, 'medication', 'Ibuprofen')).toBe('Ibuprofen')
    expect(await openValue(resolve, 'days', 3)).toBe(3)
    expect(await openValue(resolve, 'parts', ['a'])).toEqual(['a'])
    expect(await openValue(resolve, 'medication', '')).toBe('')
    expect(await openValue(resolve, 'medication', null)).toBe(null)
    expect(await openValue(resolve, 'medication', undefined)).toBe(undefined)
  })

  it('passes a truncated envelope through rather than throwing', async () => {
    // Better to show a person a value that is obviously wrong than to blank a
    // screen; a corrupt-looking string is visible and reportable, an empty
    // incident list is not.
    const sealed = await sealValue(keyA, 'k1', 'medication', 'Ibuprofen')
    const cut = sealed.slice(0, 20)
    expect(await openValue(() => keyA, 'medication', cut)).toBe(cut)
  })
})

describe('file bytes', () => {
  it('round-trips', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])
    const sealed = await sealBytes(keyA, 'general.1', 'records', bytes)
    expect(Array.from(sealed.bytes)).not.toEqual(Array.from(bytes))
    const opened = await openBytes(keyA, 'records', sealed, sealed.bytes)
    expect(Array.from(opened)).toEqual(Array.from(bytes))
  })

  it('keeps the IV and key id off the object and on the pointer', async () => {
    // So a reader refused the key learns it from a 300-byte document instead of
    // after downloading eight megabytes it cannot open.
    const bytes = new Uint8Array(64).fill(1)
    const sealed = await sealBytes(keyA, 'general.1', 'records', bytes)
    expect(sealed.keyId).toBe('general.1')
    expect(sealed.iv).toMatch(/^[A-Za-z0-9_-]{16}$/)
    // Ciphertext plus the 16-byte GCM tag, and nothing else prepended.
    expect(sealed.bytes.length).toBe(bytes.length + 16)
  })

  it('refuses bytes moved to another label', async () => {
    const bytes = new Uint8Array(32).fill(3)
    const sealed = await sealBytes(keyA, 'general.1', 'records', bytes)
    await expect(openBytes(keyA, 'photos', sealed, sealed.bytes)).rejects.toBeInstanceOf(SealedValueError)
  })

  it('reports a missing key as restricted', async () => {
    const sealed = await sealBytes(keyA, 'general.1', 'records', new Uint8Array(8))
    await expect(openBytes(null, 'records', sealed, sealed.bytes))
      .rejects.toMatchObject({ reason: 'restricted' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The hybrid scheme. Every test here is really one assertion in different
// clothes: holding the key that WRITES a health record must not let you read
// one, because firestore.rules grants exactly that combination to every member.
// ─────────────────────────────────────────────────────────────────────────────
const pair = await generateWrapKeyPair()
const other = await generateWrapKeyPair()
const pub = await importWrapPublicKey(pair.publicKey)
const priv = await importWrapPrivateKey(pair.privateKey)
const anyManager = () => priv

describe('the hybrid scheme', () => {
  // A manager: has the private half. A member: has only the public half, so the
  // resolver has nothing to hand back for a hybrid value.
  const manager = (id, scheme) => (id === 'medical.1' && scheme === 'enk' ? priv : null)
  const member = () => null

  it('round-trips for a reader holding the private half', async () => {
    const sealed = await sealHybridValue(pub, 'medical.1', 'medication', 'Ibuprofen 400mg')
    expect(await openValue(manager, 'medication', sealed)).toBe('Ibuprofen 400mg')
  })

  it('cannot be read by the writer that produced it', async () => {
    // THE property. sealHybridValue takes no argument capable of decrypting,
    // and the content key is generated inside it and never returned.
    const sealed = await sealHybridValue(pub, 'medical.1', 'medication', 'Ibuprofen')
    await expect(openValue(member, 'medication', sealed))
      .rejects.toMatchObject({ reason: 'restricted' })
  })

  it('cannot be read with another organization’s private key', async () => {
    const sealed = await sealHybridValue(pub, 'medical.1', 'medication', 'Ibuprofen')
    const wrong = await importWrapPrivateKey(other.privateKey)
    await expect(openValue(() => wrong, 'medication', sealed))
      .rejects.toMatchObject({ reason: 'corrupt' })
  })

  it('round-trips every stored type, as the symmetric scheme does', async () => {
    for (const value of ['x', '', 0, 3, true, null, ['Left hand'], { a: 1 }]) {
      const sealed = await sealHybridValue(pub, 'medical.1', 'f', value)
      expect(await openValue(anyManager, 'f', sealed)).toEqual(value)
    }
  })

  it('is recognised, parsed and told apart from the symmetric scheme', async () => {
    const hybrid = await sealHybridValue(pub, 'medical.1', 'medication', 'x')
    const symmetric = await sealValue(keyA, 'general.1', 'narrative', 'x')
    expect(isEnvelope(hybrid)).toBe(true)
    expect(parseEnvelope(hybrid).scheme).toBe('enk')
    expect(parseEnvelope(symmetric).scheme).toBe('enc')
    expect(parseEnvelope(hybrid).wrapped.length).toBe(256) // RSA-2048
  })

  it('asks the resolver for the right KIND of key', async () => {
    // A keyring that guessed from the id alone would hand an AES key back for a
    // hybrid value, and the failure would be reported as corruption rather than
    // as the refusal it is.
    const sealed = await sealHybridValue(pub, 'medical.1', 'medication', 'x')
    const asked = []
    await openValue((id, scheme) => { asked.push([id, scheme]); return priv }, 'medication', sealed)
    expect(asked).toEqual([['medical.1', 'enk']])
  })

  it('mints a fresh content key for every separate write', async () => {
    // Two independent saves must not share a key, so that recovering one
    // write's CEK does not recover another's.
    const a = await sealHybridValue(pub, 'medical.1', 'medication', 'same')
    const b = await sealHybridValue(pub, 'medical.1', 'medication', 'same')
    expect(parseEnvelope(a).wrappedB64).not.toEqual(parseEnvelope(b).wrappedB64)
  })
})

describe('hybridSealer — one content key per document write', () => {
  // Measured, not assumed: RSA-2048 unwrapping is ~0.6ms, and a manager opening
  // a 2000-record injury list at seven sealed fields each would spend about
  // nine seconds on private-key operations alone, on every re-render.
  it('shares one wrapped key across the fields of a single write', async () => {
    const sealer = await hybridSealer(pub, 'medical.1')
    const med = await sealer.seal('medication', 'Ibuprofen')
    const type = await sealer.seal('injuryType', 'Laceration')
    expect(parseEnvelope(med).wrappedB64).toBe(parseEnvelope(type).wrappedB64)
  })

  it('still gives each field its own IV', async () => {
    // Reusing an AES-GCM key is safe; reusing an IV with it is catastrophic.
    const sealer = await hybridSealer(pub, 'medical.1')
    const a = await sealer.seal('medication', 'x')
    const b = await sealer.seal('injuryType', 'x')
    expect(parseEnvelope(a).iv).not.toEqual(parseEnvelope(b).iv)
  })

  it('still refuses a value moved between fields of the same write', async () => {
    // The AAD binding has to survive the key sharing, or fields sealed together
    // would become interchangeable.
    const sealer = await hybridSealer(pub, 'medical.1')
    const med = await sealer.seal('medication', 'Ibuprofen')
    await expect(openValue(() => priv, 'injuryType', med))
      .rejects.toMatchObject({ reason: 'corrupt' })
  })

  it('leaves a different write unreadable if its own key is lost', async () => {
    // The partial-update property: fields written in separate saves carry
    // separate wrapped keys, so updating one cannot orphan the other.
    const first = await hybridSealer(pub, 'medical.1')
    const second = await hybridSealer(pub, 'medical.1')
    const a = await first.seal('medication', 'old')
    const b = await second.seal('injuryType', 'new')
    expect(parseEnvelope(a).wrappedB64).not.toBe(parseEnvelope(b).wrappedB64)
    expect(await openValue(() => priv, 'medication', a)).toBe('old')
    expect(await openValue(() => priv, 'injuryType', b)).toBe('new')
  })

  it('seals file bytes under the same shared key', async () => {
    const sealer = await hybridSealer(pub, 'medical.1')
    const field = await sealer.seal('caption', 'Discharge summary')
    const file = await sealer.sealFile('file:medical', new Uint8Array([1, 2, 3]))
    expect(file.wrapped).toBe(parseEnvelope(field).wrappedB64)
  })
})

describe('the content-key cache', () => {
  it('unwraps once for fields that share a key', async () => {
    const sealer = await hybridSealer(pub, 'medical.1')
    const fields = await Promise.all(
      ['medication', 'injuryType', 'firstAidDetail'].map((f) => sealer.seal(f, 'v')),
    )
    let unwraps = 0
    const counting = () => { unwraps += 1; return priv }
    const cache = new Map()
    // Sequential, so the count reflects cache hits rather than a race.
    for (const [i, f] of ['medication', 'injuryType', 'firstAidDetail'].entries()) {
      expect(await openValue(counting, f, fields[i], cache)).toBe('v')
    }
    expect(unwraps).toBe(3)      // the resolver is still consulted per value…
    expect(cache.size).toBe(1)   // …but only one CEK was ever unwrapped
  })

  it('collapses concurrent decryptions of one key into a single unwrap', async () => {
    // The promise is cached, not the key, so forty fields decrypting at once
    // produce one unwrap and thirty-nine awaits rather than forty races.
    const sealer = await hybridSealer(pub, 'medical.1')
    const sealed = await sealer.seal('medication', 'v')
    const cache = new Map()
    await Promise.all(Array.from({ length: 8 }, () => openValue(() => priv, 'medication', sealed, cache)))
    expect(cache.size).toBe(1)
  })

  it('does not cache a failure', async () => {
    // A poisoned entry would make one corrupt value break every other field
    // sharing its key for the rest of the session.
    const sealer = await hybridSealer(pub, 'medical.1')
    const sealed = await sealer.seal('medication', 'v')
    const wrong = await importWrapPrivateKey(other.privateKey)
    const cache = new Map()
    await expect(openValue(() => wrong, 'medication', sealed, cache)).rejects.toBeTruthy()
    expect(cache.size).toBe(0)
    expect(await openValue(() => priv, 'medication', sealed, cache)).toBe('v')
  })

  it('works with no cache supplied at all', async () => {
    const sealer = await hybridSealer(pub, 'medical.1')
    const sealed = await sealer.seal('medication', 'v')
    expect(await openValue(() => priv, 'medication', sealed)).toBe('v')
  })

  it('is idempotent and refuses a moved value, like the symmetric scheme', async () => {
    const once = await sealHybridValue(pub, 'medical.1', 'medication', 'x')
    expect(await sealHybridValue(pub, 'medical.1', 'medication', once)).toBe(once)
    await expect(openValue(anyManager, 'narrative', once))
      .rejects.toMatchObject({ reason: 'corrupt' })
  })

  it('seals file bytes the uploader cannot reopen', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]) // '%PDF'
    const sealed = await sealHybridBytes(pub, 'medical.1', 'records', bytes)
    expect(sealed.scheme).toBe('enk')
    await expect(openBytes(null, 'records', sealed, sealed.bytes))
      .rejects.toMatchObject({ reason: 'restricted' })
    expect(Array.from(await openBytes(priv, 'records', sealed, sealed.bytes))).toEqual(Array.from(bytes))
  })
})


describe('importKey', () => {
  it('refuses anything that is not a 256-bit key', async () => {
    await expect(importKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/)
  })

  it('accepts the base64URL form the callable returns', async () => {
    const key = await importKey(toB64u(rawKey(4)))
    const sealed = await sealValue(key, 'k1', 'f', 'v')
    expect(await openValue(() => key, 'f', sealed)).toBe('v')
  })
})
