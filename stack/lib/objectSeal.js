// ─────────────────────────────────────────────────────────────────────────────
// Encrypting the objects already sitting in the bucket.
//
// Setting `files: true` sealed every NEW upload. Every photo, drill evidence
// shot and attachment uploaded before that is still lying in Cloud Storage in
// the clear, readable by anything that reaches the bucket rather than the app —
// an exported backup, a misconfiguration, project Viewer. Same sentence as every
// other migration here: closing the write path closes nothing already written.
//
// ── Why this one is a Cloud Function when the field backfill is not ──────────
//
// src/shared/crypto/backfill.js runs in the browser specifically to avoid
// duplicating the policy table across the functions/ seam, because the AAD bound
// into a sealed FIELD is its policy path and a one-character drift would seal
// records nothing could ever open again.
//
// That argument does not survive contact with file bytes. A tenant's objects run
// to gigabytes; downloading them into a browser tab, decrypting, re-encrypting
// and uploading is not a migration, it is an outage. So this runs server-side
// with the Admin SDK, and pays the duplication price the field backfill refused.
//
// What is duplicated is deliberately tiny, and that is the whole reason it is
// acceptable here: not a table of forty field paths, but ONE label per key class
// (`file:general`, `file:medical`) and the AAD format string. Four constants.
//
// And it is not trusted to stay in step by comment alone. The test at
// src/shared/crypto/objectSeal.crossSeam.test.js imports THIS module and the
// client's envelope.js together, seals with one and opens with the other, in
// both key classes. If the two ever disagree about a byte, that test goes red —
// which is the guarantee the field backfill got by having no second
// implementation at all.
//
// ── The ordering, which is the safety property ───────────────────────────────
//
// A sealed object is written to a NEW path and the original is not touched
// until the new one has been downloaded back and decrypted successfully. Write,
// verify, re-point, THEN delete — the ordering confineMedicalRecords uses, and
// for the same reason: an interrupted run must leave the file readable in one
// place rather than corrupt in one and gone from the other.
//
// Sealing in place would mean overwriting the only copy with bytes that have
// never been read back. A truncated upload, a wrong key, an interrupted stream —
// any of them and the photograph is gone, with the pointer still confidently
// naming it.
//
// Pure planning and crypto only. Nothing here touches Firestore or Storage;
// index.js does that with what these functions decide, which is what makes the
// decisions testable without a bucket.
// ─────────────────────────────────────────────────────────────────────────────
import { toB64u, fromB64u, WRAP_ALG, IV_BYTES } from './dataKeys.js'

const subtle = () => globalThis.crypto.subtle
const utf8 = new TextEncoder()

/**
 * MUST stay byte-identical to aad() in src/shared/crypto/envelope.js and
 * fileLabel() in src/shared/crypto/policy.js.
 *
 * `1` is that file's VERSION constant. The label is per CLASS and not per
 * collection, deliberately and for a reason this migration depends on: objects
 * move between collections here (confineMedicalRecords lifts one from the photo
 * prefix to the medical one), and a collection-shaped label would make every
 * moved file unopenable. Naming the class keeps the binding that matters — a
 * medical object replayed as a general one still fails.
 *
 * Verified against the client by the cross-seam test named in the header.
 */
export const fileLabel = (keyClass) => `file:${keyClass}`
export const fileAad = (orgId, keyClass) =>
  utf8.encode(`ohsms:1:${String(orgId ?? '')}:${fileLabel(keyClass)}`)

/** MUST match GENERAL/MEDICAL in policy.js and dataKeys.js. */
export const GENERAL = 'general'
export const MEDICAL = 'medical'
export const isHybridClass = (keyClass) => keyClass === MEDICAL

/**
 * Where the objects are, and which key seals each.
 *
 * MUST stay in step with the `files: true` entries in
 * src/shared/crypto/policy.js. A collection given files:true there and forgotten
 * here would seal its new uploads and never seal its history — silently, and
 * only discovered by somebody reading the bucket.
 */
export const FILE_TARGETS = [
  { collection: 'injuries/records', parent: 'injuries', sub: 'records', keyClass: MEDICAL },
  { collection: 'illnesses/files', parent: 'illnesses', sub: 'files', keyClass: MEDICAL },
  { collection: 'incidents/photos', parent: 'incidents', sub: 'photos', keyClass: GENERAL },
  { collection: 'mockDrills/photos', parent: 'mockDrills', sub: 'photos', keyClass: GENERAL },
]

/**
 * How many objects one run may seal.
 *
 * Each one is a download, an encrypt, an upload, a download to verify, a
 * Firestore write and a delete — six operations over the network, on payloads up
 * to ten megabytes, and they are sequential because the ordering IS the safety
 * property. The cap keeps a run inside the 540s budget and turns a large estate
 * into a series of finished runs rather than one that dies half way and reports
 * nothing. Whatever is left comes back as `remaining`.
 */
export const MAX_OBJECTS_PER_RUN = 60

/**
 * The suffix that marks a sealed object in the bucket.
 *
 * The destination is DETERMINISTIC — `<path>.enc` — rather than a fresh random
 * name, and that is what makes an interrupted run resumable: a re-run computes
 * the same destination, finds its own half-finished work, and finishes it
 * instead of leaving a second orphaned copy behind every time.
 *
 * It also means an operator looking at the bucket can see at a glance which
 * objects have been through this and which have not.
 */
export const SEALED_SUFFIX = '.enc'

/**
 * Where an object moves to, or null if it must not be touched.
 *
 * Refuses anything outside this org's own prefix and anything containing '..',
 * mirroring movedStoragePath in medicalRecords.js. `path` is a CLIENT-WRITABLE
 * field and this runs with Admin SDK privileges that never consult
 * storage.rules: a pointer naming another tenant's object would otherwise have
 * this job read that object, copy it into this org, and delete the original.
 * Refused, and reported.
 */
export function sealedPath(path, orgId) {
  const p = String(path ?? '').trim()
  const prefix = `orgs/${String(orgId ?? '').trim()}/`
  if (!p || !orgId || !p.startsWith(prefix) || p.includes('..')) return null
  // Exactly three segments, as storagePath() always writes. Anything deeper was
  // not written by this app and this job does not get to guess at its shape.
  const rest = p.slice(prefix.length)
  const cut = rest.indexOf('/')
  const file = cut < 0 ? '' : rest.slice(cut + 1)
  if (cut <= 0 || !file || file.includes('/')) return null
  if (p.endsWith(SEALED_SUFFIX)) return p // already moved; a resumed run
  return `${p}${SEALED_SUFFIX}`
}

/**
 * Does this pointer name an object that still needs sealing?
 *
 * `encIv` is the marker the client's isSealedFile() tests, so this agrees with
 * the reader by construction: anything the app would treat as sealed is skipped,
 * and anything it would treat as plaintext is a candidate.
 *
 * A pointer with no `path` is skipped and is not a failure — it is the inline
 * fallback, where the file lives base64 INSIDE the document and is sealed by the
 * FIELD policy instead. Two different mechanisms, and this one owns neither
 * end of that.
 */
export function needsObjectSealing(pointer) {
  if (!pointer || typeof pointer !== 'object') return false
  if (!String(pointer.path ?? '').trim()) return false
  return !String(pointer.encIv ?? '').trim()
}

// ── The crypto ───────────────────────────────────────────────────────────────

async function importGeneralKey(raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Seal one object's bytes.
 *
 * `keys` is what the org's keyset unwraps to:
 *   { general: { keyId, key: Uint8Array },
 *     medical: { keyId, publicKey: Uint8Array(spki), privateKey: Uint8Array(pkcs8) } }
 *
 * Returns the pointer metadata AND the ciphertext, in exactly the field names
 * sealFileBytes() produces on the client — encScheme/encKeyId/encIv/encWrapped —
 * because the reader does not care which of the two wrote them.
 */
export async function sealObjectBytes(keys, orgId, keyClass, bytes) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const additionalData = fileAad(orgId, keyClass)

  if (!isHybridClass(keyClass)) {
    const entry = keys?.general
    if (!entry?.key) throw new Error('No general key for this organization.')
    const key = await importGeneralKey(entry.key)
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData }, key, bytes)
    return { encScheme: 'enc', encKeyId: entry.keyId, encIv: toB64u(iv), bytes: new Uint8Array(ct) }
  }

  // Hybrid, exactly as the client does it: a fresh content key per object,
  // wrapped with the org's PUBLIC half. The private half is never used to write
  // — this job holds it only so it can verify below.
  const entry = keys?.medical
  if (!entry?.publicKey) throw new Error('No medical key for this organization.')
  const pub = await subtle().importKey('spki', entry.publicKey, WRAP_ALG, false, ['encrypt'])
  const cek = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData }, cek, bytes)
  const wrapped = await subtle().encrypt(WRAP_ALG, pub, await subtle().exportKey('raw', cek))

  return {
    encScheme: 'enk',
    encKeyId: entry.keyId,
    encIv: toB64u(iv),
    encWrapped: toB64u(new Uint8Array(wrapped)),
    bytes: new Uint8Array(ct),
  }
}

/**
 * Open an object's bytes again — the verification step, and nothing else.
 *
 * This is what licences the delete. Nothing is removed until the re-uploaded
 * object has been downloaded back and passed through here, so a truncated
 * upload or a wrong key leaves the original exactly where it was.
 */
export async function openObjectBytes(keys, orgId, keyClass, meta, bytes) {
  const additionalData = fileAad(orgId, keyClass)
  const iv = fromB64u(meta.encIv)

  if (meta.encScheme === 'enk') {
    const entry = keys?.medical
    if (!entry?.privateKey) throw new Error('No medical private key to verify with.')
    const priv = await subtle().importKey('pkcs8', entry.privateKey, WRAP_ALG, false, ['decrypt'])
    const raw = await subtle().decrypt(WRAP_ALG, priv, fromB64u(meta.encWrapped))
    const cek = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData }, cek, bytes))
  }

  const entry = keys?.general
  if (!entry?.key) throw new Error('No general key to verify with.')
  const key = await importGeneralKey(entry.key)
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData }, key, bytes))
}

/**
 * Are these the same bytes?
 *
 * Length first so a truncated download — the realistic failure — is rejected
 * without walking anything, and a plain loop rather than a hash because the
 * comparison is against bytes already in memory and a digest would only add a
 * second thing to get wrong.
 */
export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * The pointer fields to write, given what sealObjectBytes produced.
 *
 * `url` is deliberately CLEARED rather than re-minted. The old value is a
 * getDownloadURL for the plaintext object — a permanent, unauthenticated bearer
 * link that answers to no rule and keeps working after the holder leaves the
 * organization. Sealing the bytes while leaving that string on the document
 * would confine the file and leave the door: the object it names is about to be
 * deleted, so the link breaks anyway, and carrying a dead credential forward
 * helps nobody. Readers resolve `path` through an authenticated request instead.
 */
export function pointerUpdate(sealed, toPath) {
  return {
    path: toPath,
    url: '',
    encScheme: sealed.encScheme,
    encKeyId: sealed.encKeyId,
    encIv: sealed.encIv,
    ...(sealed.encWrapped ? { encWrapped: sealed.encWrapped } : {}),
  }
}
