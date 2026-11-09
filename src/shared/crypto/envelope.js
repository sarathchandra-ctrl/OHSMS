// ─────────────────────────────────────────────────────────────────────────────
// The wire format of an encrypted value, and the four operations on it.
//
// This file knows about AES-GCM and about a string layout. It knows nothing
// about organizations, roles, callables or which fields are sensitive — those
// decisions live in policy.js and keyring.js, and keeping them out of here is
// what makes every guarantee below testable against a raw key with no Firebase
// anywhere near it.
//
// ── The format ───────────────────────────────────────────────────────────────
//
//     enc:1:<keyId>:<iv>:<ciphertext>
//
// A STRING, deliberately, rather than a map of {iv, ct} — because it has to
// drop into fields that already exist and are already typed. `medication` is a
// string today and stays a string; `narrative` likewise. A map would change the
// shape of every document, break every `.trim()` and `.toLowerCase()` in the
// renderers, and turn a confidentiality change into a schema migration for
// forty screens. It also survives every transport this app already uses without
// special-casing: JSON, a Firestore write, a CSV export, a PDF cell.
//
// Both binary segments are base64URL with no padding. Not standard base64: `+`
// and `/` are fine inside a Firestore string but are not fine in the other
// places these values reach — a URL query, a filename, a CSV cell that a
// spreadsheet decides to interpret — and `=` padding is the character most
// likely to be stripped by something well-meaning in between. The alphabet is
// therefore [A-Za-z0-9_-], which is the same alphabet storagePath()'s seg()
// already guarantees it will not rewrite.
//
// ── Why the plaintext is JSON ────────────────────────────────────────────────
//
// `bodyParts` is an array, `daysToReturnToWork` is a number-or-empty-string,
// `firstAidDone` is a boolean. Encrypting only strings would leave the array
// and the number in the clear, and encrypting their `String(v)` would hand back
// "3" where a 3 was stored and "a,b" where ['a','b'] was — silently, on read,
// forever after. JSON.stringify/parse round-trips every value this app stores
// in an encrypted field and restores the ORIGINAL type, so a caller cannot tell
// from the value it gets back that the field was ever encrypted.
//
// The one thing it does not round-trip is `undefined`, which JSON has no
// representation for. sealValue returns it unchanged rather than storing "null":
// an absent field and a field holding null are different answers to a clinical
// question, and Firestore already refuses undefined outright.
//
// ── Why there is additional authenticated data ───────────────────────────────
//
// AES-GCM authenticates its ciphertext, so nobody can alter a value without the
// tag failing. What a tag alone does NOT stop is MOVING an intact ciphertext:
// one key encrypts every field in an organization, so a ciphertext lifted out of
// `injuries/…/medication` and pasted into a field the app renders to everyone
// would decrypt perfectly and print the medication on a public screen. Anyone
// with write access to any encrypted field could read every encrypted field
// that way, which would make the whole exercise decorative.
//
// So every value is bound, at encryption time, to `orgId` and to the field path
// it belongs to. Move it anywhere else and decryption fails closed.
//
// What the binding deliberately does NOT include is the collection or the
// document id, and that is not an oversight. Documents in this app move:
// confineMedicalRecords lifts a record pointer out of incidents/{id}/photos and
// writes it into injuries/{id}/records, and seedInjuryRecords copies clinical
// fields from one document into another. A binding that named the collection
// would turn every one of those migrations into a decryption failure — data
// loss dressed up as a security control. The field path is the finest binding
// that survives the moves this codebase actually performs.
//
// ── The IV, and the bound that governs key rotation ──────────────────────────
//
// 96 random bits per value, from the platform CSPRNG, never a counter. With a
// random IV, AES-GCM's safety margin is a birthday bound: collision probability
// stays negligible below roughly 2^32 encryptions under one key. That is the
// real reason keyId is in the format — not because a key is expected to leak,
// but because one eventually has to be retired, and a format with no key
// identifier can only ever be rotated by rewriting every document at once.
// Old ciphertext keeps naming the key that sealed it and stays readable.
// ─────────────────────────────────────────────────────────────────────────────

// ── The second scheme, and why one is not enough ─────────────────────────────
//
// Everything above assumes the reader and the writer are the same population.
// For incidents, meetings and drills they are. For health records they are
// explicitly NOT, and firestore.rules says so out loud: /injuries, its /records
// subcollection and /illnesses are `allow read: if isManagerOf(orgId)`, while
// the WRITE comes through the generic rule as isWriterOf — so an ordinary
// member fills in Step 1a of the incident wizard, files a colleague's medication
// and days off, and cannot read any of it back. That asymmetry is the control.
//
// A symmetric key cannot express it. Handing the member a key so they can
// encrypt hands them the key that decrypts, and every member could then read
// every colleague's clinical record — the exact exposure the rules were changed
// to close, reintroduced by the thing meant to reinforce them. Encryption that
// has to be given to everyone who writes protects the data from nobody who
// matters.
//
// So health fields use a hybrid:
//
//     enk:1:<keyId>:<wrappedCek>:<iv>:<ciphertext>
//
//   · a fresh 256-bit content key (CEK) per value, used once for AES-GCM;
//   · that CEK wrapped with the organization's RSA-OAEP PUBLIC key, which any
//     writer may hold because a public key cannot decrypt anything;
//   · the private half released only to admin and manager, on the same test
//     isManagerOf already applies.
//
// The writer discards the CEK the moment the value is sealed and keeps no way
// back to it. Write-without-read stops being a rule that a rules bug can undo
// and becomes arithmetic.
//
// Per VALUE rather than per document, which costs ~340 characters of wrapped key
// on each sealed field. The cheaper design — one CEK per document, wrapped once
// — cannot survive a partial update: `updateDoc(ref, { medication })` would have
// to reuse the document's existing CEK, and the member issuing that update
// cannot unwrap it, so they would have to mint a new one and every field they
// did NOT write would become permanently unreadable. Six fields on an injury
// record is about two kilobytes against Firestore's one-megabyte limit. Silent
// data loss on a partial write is not a trade worth two kilobytes.

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

export const SCHEME = 'enc'
export const HYBRID_SCHEME = 'enk'
export const VERSION = '1'
const PREFIX = `${SCHEME}:${VERSION}:`
const HYBRID_PREFIX = `${HYBRID_SCHEME}:${VERSION}:`

/** The wrapping algorithm for the hybrid scheme. 2048 keeps the segment short. */
export const WRAP_ALG = { name: 'RSA-OAEP', hash: 'SHA-256' }
export const WRAP_MODULUS_BITS = 2048

/** 96 bits, the size AES-GCM is specified and optimised for. */
export const IV_BYTES = 12
/** AES-256. Anything else is rejected at import rather than half-working. */
export const KEY_BYTES = 32

/**
 * A strict shape test, not a prefix test.
 *
 * The loose version — `s.startsWith('enc:1:')` — is a confidentiality bug
 * waiting for the first person who types "enc:1:whatever" into a free-text
 * field, because sealValue treats anything that looks sealed as already sealed
 * and passes it through UNENCRYPTED. Requiring the exact segment count, the
 * exact base64URL alphabet and the exact 16-character (12-byte) IV makes that
 * collision something a person cannot produce by accident and can only produce
 * on purpose by pasting a real envelope — at which point they are storing their
 * own ciphertext, which is not an exposure.
 */
const ENVELOPE_RE = /^enc:1:([A-Za-z0-9._-]{1,32}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/
// The wrapped-key segment is 342 characters for the RSA-2048 key this ships
// with. The range accepts a longer modulus so a future rotation to 3072 bits is
// a key change and not a format change — and still refuses a value where that
// segment is obviously something else.
const HYBRID_RE = /^enk:1:([A-Za-z0-9._-]{1,32}):([A-Za-z0-9_-]{342,1400}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/

/** Does this value already carry a well-formed envelope, of either scheme? */
export function isEnvelope(value) {
  return typeof value === 'string' && (ENVELOPE_RE.test(value) || HYBRID_RE.test(value))
}

/**
 * `{ scheme, keyId, wrapped?, iv, ct }` with the binary parts decoded, or null.
 *
 * `wrapped` is present only for the hybrid scheme, and its presence is what
 * tells openValue which of the two key kinds to ask the resolver for.
 */
export function parseEnvelope(value) {
  if (typeof value !== 'string') return null
  const sym = ENVELOPE_RE.exec(value)
  const hyb = sym ? null : HYBRID_RE.exec(value)
  if (!sym && !hyb) return null
  try {
    return sym
      ? { scheme: SCHEME, keyId: sym[1], iv: fromB64u(sym[2]), ct: fromB64u(sym[3]) }
      // wrappedB64 is kept alongside the decoded bytes purely as a cache key:
      // a Map keys a Uint8Array by identity, so two fields carrying the same
      // wrapped key would miss every time and the cache would do nothing.
      : {
        scheme: HYBRID_SCHEME,
        keyId: hyb[1],
        wrapped: fromB64u(hyb[2]),
        wrappedB64: hyb[2],
        iv: fromB64u(hyb[3]),
        ct: fromB64u(hyb[4]),
      }
  } catch {
    // The regex proved the alphabet, not that the length is a whole number of
    // bytes. A truncated value lands here and is treated as "not an envelope",
    // which makes openValue pass it through rather than throw — see the note
    // there on why passthrough is the correct failure for unrecognised input.
    return null
  }
}

// ── base64URL ────────────────────────────────────────────────────────────────
//
// Chunked through fromCharCode because these encode FILE bytes as well as
// field values, and `String.fromCharCode(...tenMegabytes)` overflows the
// argument stack and throws — a limit that does not show up until somebody
// uploads a discharge summary bigger than the test fixtures.

export function toB64u(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < a.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000))
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * The binding described in the header.
 *
 * Versioned along with the format so a future scheme can bind differently
 * without silently accepting values sealed under the old rules.
 */
export function aad(fieldPath) {
  return utf8.encode(`ohsms:${VERSION}:org:${String(fieldPath ?? '')}`)
}

/**
 * Raw key bytes (or a base64URL string) as a non-extractable CryptoKey.
 *
 * `false` for extractable is not ceremony. The key arrives from a callable and
 * is held for the life of the tab; a non-extractable CryptoKey cannot be read
 * back out by anything that later gets a reference to it — including an XSS
 * payload that finds the keyring, which is the realistic way this key gets
 * stolen in a browser. It can still be USED for as long as the tab lives; what
 * it cannot do is be serialised and posted somewhere.
 */
export async function importKey(raw) {
  const bytes = typeof raw === 'string' ? fromB64u(raw) : new Uint8Array(raw)
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`A data key must be ${KEY_BYTES} bytes (AES-256), got ${bytes.length}.`)
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Thrown when a value is genuinely sealed and this caller cannot open it.
 *
 * Separated from every other failure so the layer above can tell the two apart:
 * `restricted` means the reader is not entitled to this key and the field
 * should be redacted on screen, which is a NORMAL outcome for the auditor
 * looking at an injury record. `corrupt` means a value that claims to be an
 * envelope failed its authentication tag, which is never normal and belongs in
 * Sentry. Collapsing them would either spam the error tracker with every
 * auditor page view or bury real tampering under expected refusals.
 */
export class SealedValueError extends Error {
  constructor(reason, fieldPath, cause) {
    super(reason === 'restricted'
      ? `No key for this value (${fieldPath}).`
      : `A sealed value failed authentication (${fieldPath}).`)
    this.name = 'SealedValueError'
    this.reason = reason
    this.fieldPath = fieldPath
    this.cause = cause
  }
}

/**
 * Encrypt one value.
 *
 * Returns the value unchanged in two cases, and both are load-bearing:
 *
 *   · `undefined` — see the header. There is nothing to encrypt and Firestore
 *     refuses the value anyway.
 *   · an already-sealed value — because writes in this app are read-modify-write
 *     (updateIncident merges a partial over what it read back), so a document
 *     round-trips through here repeatedly. Without idempotency each save would
 *     wrap the previous ciphertext in another layer, and the fifth edit of an
 *     incident would need five decryptions to read. Nothing would look wrong
 *     until the document outgrew Firestore's 1MB limit.
 */
export async function sealValue(key, keyId, fieldPath, value) {
  if (value === undefined) return undefined
  if (isEnvelope(value)) return value
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(String(keyId || ''))) {
    // A keyId carrying a colon would produce a string that parses back with the
    // wrong segments — silently unreadable, and only for the records written
    // while the bad id was live.
    throw new Error(`Invalid key id: ${keyId}`)
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(fieldPath) },
    key,
    utf8.encode(JSON.stringify(value === undefined ? null : value)),
  )
  return `${PREFIX}${keyId}:${toB64u(iv)}:${toB64u(new Uint8Array(ct))}`
}

/**
 * Decrypt one value.
 *
 * `resolveKey(keyId)` returns a CryptoKey, or null/undefined when this reader
 * has no such key — which is an answer, not an error, and is how the auditor
 * reads an injury record with the clinical columns redacted instead of getting
 * a blank page.
 *
 * ANYTHING THAT IS NOT AN ENVELOPE COMES BACK UNCHANGED. That is the property
 * that makes the rollout survivable. Every collection will hold a mixture of
 * sealed and unsealed values for as long as the backfill takes, and for
 * whatever it declines to touch after that; a reader that threw on plaintext
 * would take the whole app down the moment it shipped, and one that returned
 * null would render every historical record as empty — which in a safety system
 * reads as "this incident had no narrative" rather than "this is still
 * encrypting".
 */
export async function openValue(resolveKey, fieldPath, value, cekCache) {
  const parsed = parseEnvelope(value)
  if (!parsed) return value

  // The resolver is told which KIND of key the value needs — a symmetric data
  // key for `enc`, the RSA private half for `enk` — because a keyring that
  // guessed from the id would hand back an AES key for a hybrid value and
  // report the resulting failure as corruption rather than as a refusal.
  const key = await resolveKey(parsed.keyId, parsed.scheme)
  if (!key) throw new SealedValueError('restricted', fieldPath)

  let contentKey = key
  if (parsed.scheme === HYBRID_SCHEME) {
    try {
      contentKey = await unwrapContentKey(key, parsed.wrapped, parsed.wrappedB64, cekCache)
    } catch (e) {
      // Nothing here can distinguish "wrong private key" from "altered wrapped
      // segment", and it must not try: both mean the value is not to be trusted.
      throw new SealedValueError('corrupt', fieldPath, e)
    }
  }

  let plain
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parsed.iv, additionalData: aad(fieldPath) },
      contentKey,
      parsed.ct,
    )
  } catch (e) {
    // A tag failure here means one of three things and the message must not
    // guess which: the value was altered, it was moved from another field, or
    // it was sealed for another organization. All three are "do not trust this".
    throw new SealedValueError('corrupt', fieldPath, e)
  }
  return JSON.parse(fromUtf8.decode(plain))
}

// ── The hybrid scheme ────────────────────────────────────────────────────────

/**
 * A wrapped content key, unwrapped — through a cache when one is supplied.
 *
 * The cache is keyed by the wrapped bytes themselves, which is what makes it
 * work at all: hybridSealer reuses one CEK across every field of a document
 * write, so those fields carry an IDENTICAL wrapped segment and collapse to a
 * single RSA operation. Re-emissions from onSnapshot then cost nothing, which
 * matters because a live list re-renders on every change anybody makes.
 *
 * The PROMISE is cached rather than the key, so forty fields decrypting
 * concurrently produce one unwrap and thirty-nine awaits rather than forty
 * unwraps racing each other.
 *
 * A rejected unwrap is evicted. Caching the rejection would mean one corrupted
 * value poisons every other field sharing its CEK for the life of the session,
 * including after the underlying cause is fixed and the page reloaded data.
 */
async function unwrapContentKey(privateKey, wrapped, cacheKey, cache) {
  const hit = cache?.get?.(cacheKey)
  if (hit) return hit

  const job = (async () => {
    const raw = await crypto.subtle.decrypt(WRAP_ALG, privateKey, wrapped)
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
  })()

  if (cache?.set) {
    cache.set(cacheKey, job)
    job.catch(() => cache.delete?.(cacheKey))
  }
  return job
}

/** The org's public half, from base64URL SPKI. Safe to hand to any writer. */
export async function importWrapPublicKey(spki) {
  const bytes = typeof spki === 'string' ? fromB64u(spki) : new Uint8Array(spki)
  return crypto.subtle.importKey('spki', bytes, WRAP_ALG, false, ['encrypt'])
}

/**
 * The org's private half, from base64URL PKCS8. Managers only.
 *
 * Non-extractable for the same reason importKey is: once this is in the tab it
 * can be used but not serialised back out, so the realistic browser-side theft
 * — a script that finds the keyring and posts what it holds — gets a handle it
 * cannot copy rather than the private key of every health record in the tenant.
 */
export async function importWrapPrivateKey(pkcs8) {
  const bytes = typeof pkcs8 === 'string' ? fromB64u(pkcs8) : new Uint8Array(pkcs8)
  return crypto.subtle.importKey('pkcs8', bytes, WRAP_ALG, false, ['decrypt'])
}

/**
 * A fresh org wrapping keypair, exported as base64URL SPKI/PKCS8.
 *
 * Lives here rather than in functions/ because the format has to match what
 * importWrapPublicKey/importWrapPrivateKey accept, and a generator that drifts
 * from its own importers is only discovered by the first organization that
 * cannot read anything it wrote. functions/ calls the same WebCrypto.
 */
export async function generateWrapKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { ...WRAP_ALG, modulusLength: WRAP_MODULUS_BITS, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    publicKey: toB64u(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
    privateKey: toB64u(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  }
}

/** A content key. Extractable only so it can be wrapped, then dropped. */
async function freshContentKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
}

async function wrapContentKey(publicKey, cek) {
  const raw = await crypto.subtle.exportKey('raw', cek)
  return new Uint8Array(await crypto.subtle.encrypt(WRAP_ALG, publicKey, raw))
}

/**
 * One content key, reused for every field of a single document write.
 *
 * This exists for a measured reason. RSA-2048 unwrapping costs ~0.6ms, and a
 * manager opening the injury list decrypts every clinical field of every record
 * at once — 2000 records at seven fields each is 14,000 unwraps, about nine
 * seconds, repeated on every onSnapshot re-emission. A key per FIELD is
 * unaffordable at the size this app is actually used.
 *
 * Sharing one CEK across the fields of one write costs nothing in secrecy: each
 * field still gets its own random IV and its own AAD binding, so values still
 * cannot be transplanted between fields, and anyone able to unwrap the CEK holds
 * the private key — which opens every other field anyway. What it buys is that
 * the wrapped segment is IDENTICAL across those fields, so the cache in
 * openValue collapses them to one unwrap.
 *
 * Per WRITE and not per document, deliberately. A partial update mints a new
 * CEK for the fields it touches and leaves every untouched field pointing at the
 * wrapped key already inline beside it — so a member who cannot unwrap anything
 * can still update one field without orphaning the rest. That is the property a
 * document-level CEK could not have, and losing a colleague's medication to a
 * partial save is not a trade worth any amount of speed.
 */
export async function hybridSealer(publicKey, keyId) {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(String(keyId || ''))) {
    throw new Error(`Invalid key id: ${keyId}`)
  }
  const cek = await freshContentKey()
  const wrapped = toB64u(await wrapContentKey(publicKey, cek))

  const encrypt = async (label, bytes) => {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(label) },
      cek,
      bytes,
    )
    return { iv, ct: new Uint8Array(ct) }
  }

  return {
    keyId,
    async seal(fieldPath, value) {
      if (value === undefined) return undefined
      if (isEnvelope(value)) return value
      const { iv, ct } = await encrypt(fieldPath, utf8.encode(JSON.stringify(value === undefined ? null : value)))
      return `${HYBRID_PREFIX}${keyId}:${wrapped}:${toB64u(iv)}:${toB64u(ct)}`
    },
    async sealFile(label, bytes) {
      const { iv, ct } = await encrypt(label, bytes)
      return { scheme: HYBRID_SCHEME, keyId, wrapped, iv: toB64u(iv), bytes: ct }
    },
  }
}

/**
 * Encrypt one value so that only a holder of the private half can read it.
 *
 * The caller passes the PUBLIC key. There is no argument to this function that
 * could decrypt anything, which is the property the whole scheme rests on: the
 * member filling in Step 1a runs this, and nothing in their tab — not the
 * arguments, not the return value, not the discarded CEK — can be turned back
 * into the medication they just typed.
 */
export async function sealHybridValue(publicKey, keyId, fieldPath, value) {
  if (value === undefined) return undefined
  if (isEnvelope(value)) return value
  return (await hybridSealer(publicKey, keyId)).seal(fieldPath, value)
}

// ── Files ────────────────────────────────────────────────────────────────────
//
// The bytes of a GP letter cannot go in a string field, so they do not use the
// envelope format. They get the same key, the same AAD discipline and the same
// per-object IV; what differs is that the IV and keyId ride on the POINTER
// document (which is itself a Firestore document under rules) rather than being
// prepended to the object. Two reasons: the object stays exactly the length of
// the ciphertext, so a range request still works, and a reader that is refused
// the key learns that fact from a 300-byte document instead of after
// downloading eight megabytes it cannot open.

/**
 * `{ scheme, keyId, iv, bytes }` — persist everything but `bytes` on the
 * pointer document, upload `bytes` to the bucket.
 */
export async function sealBytes(key, keyId, label, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(label) },
    key,
    bytes,
  )
  return { scheme: SCHEME, keyId, iv: toB64u(iv), bytes: new Uint8Array(ct) }
}

/**
 * The same, for bytes a writer must not be able to read back.
 *
 * This is the one that medical records use: the member who attaches a
 * colleague's discharge summary uploads it and cannot open it afterwards, which
 * is what firestore.rules and storage.rules both already claim about that file
 * and could not previously enforce against anyone holding the object.
 */
export async function sealHybridBytes(publicKey, keyId, label, bytes) {
  return (await hybridSealer(publicKey, keyId)).sealFile(label, bytes)
}

/**
 * The plaintext bytes back. Throws SealedValueError exactly as openValue does.
 *
 * `meta` is what sealBytes/sealHybridBytes returned, minus the bytes — i.e. the
 * fields the pointer document carries.
 */
export async function openBytes(key, label, meta, bytes, cekCache) {
  if (!key) throw new SealedValueError('restricted', label)
  const { scheme = SCHEME, iv, wrapped } = meta || {}
  try {
    let contentKey = key
    if (scheme === HYBRID_SCHEME) {
      contentKey = await unwrapContentKey(key, fromB64u(wrapped), wrapped, cekCache)
    }
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64u(iv), additionalData: aad(label) },
      contentKey,
      bytes,
    )
    return new Uint8Array(plain)
  } catch (e) {
    throw new SealedValueError('corrupt', label, e)
  }
}
