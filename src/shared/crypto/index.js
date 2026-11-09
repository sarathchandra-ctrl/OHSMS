// ─────────────────────────────────────────────────────────────────────────────
// The two functions the rest of the app calls.
//
//     sealDoc(orgId, collection, data)   before every write
//     openDoc(orgId, collection, data)   after every read
//
// Everything below them — which fields, which key, which scheme, what happens
// when a key is missing — is decided in policy.js, keyring.js and envelope.js.
// A module calls these two and does not otherwise know that encryption exists,
// which is deliberate: the alternative is an `if (encrypted)` in forty
// renderers, thirty-nine of which stay correct.
//
// ── Both are safe on data that is not sealed ─────────────────────────────────
//
// openDoc passes any value that is not a well-formed envelope straight through,
// and sealDoc passes any value that already IS one straight through. Together
// those two make every ordering work: sealed data read by an old build, plain
// data read by a new one, a half-migrated collection, a document that was
// written while the switch was off and updated after it was turned on. There is
// no flag day and no moment where a record is unreadable because the code and
// the data disagree about an era.
//
// ── What openDoc does with a value it cannot open ────────────────────────────
//
// It removes the field and records the path in `_restricted`. It does NOT
// throw, and it does not leave the ciphertext in place. This is the auditor
// opening an injury record, and it is a normal, designed page view rather than
// an error: they see the record with the clinical columns absent, and every
// `(injury.bodyParts || []).map(...)` in the renderers keeps working without one
// of them being edited. See OMIT in policy.js.
//
// `_restricted` is there so a screen can say "restricted" rather than silently
// showing a record that looks complete and is not. A safety system that displays
// a partial record as if it were whole is worse than one that refuses to display
// it.
// ─────────────────────────────────────────────────────────────────────────────
import { openValue, openBytes, SealedValueError, SCHEME } from './envelope'
import { mapSealed, policyFor, keyClassFor, fileLabel, OMIT } from './policy'
import { sealerFor, resolverFor, contentKeyCache, sealingEnabled } from './keyring'
import { reportError } from '../monitoring'

export { sealingEnabled, NoKeyError, clearKeyring, canOpen, loadKeys } from './keyring'
export { GENERAL, MEDICAL, policyFor, keyClassFor, SEALED_COLLECTIONS, sealsFiles } from './policy'
export { SealedValueError } from './envelope'

/** The field openDoc lists unreadable paths on. */
export const RESTRICTED_KEY = '_restricted'

/**
 * Seal a document's policy fields, ready to write.
 *
 * Returns the data unchanged when the collection has no policy, or when sealing
 * is switched off. Throws NoKeyError when sealing is ON and this session has no
 * key for the class — never a silent plaintext write, which would look exactly
 * like success and is the failure this whole exercise exists to prevent.
 *
 * Safe on a PARTIAL payload. Every module here writes with merges and field
 * updates rather than whole documents, and leafRefs only visits paths that are
 * actually present — so `updateDoc(ref, { medication })` seals the one field it
 * carries and says nothing about the rest.
 */
export async function sealDoc(collection, data) {
  const keyClass = keyClassFor(collection)
  if (!keyClass || data == null) return data
  if (!sealingEnabled) return data

  const sealer = await sealerFor(keyClass)
  if (!sealer) return data
  return mapSealed(collection, data, (fieldPath, value) => sealer.seal(fieldPath, value))
}

/**
 * Open a document's policy fields, after reading.
 *
 * Never throws and never rejects. It is called from inside onSnapshot handlers,
 * where an exception is an uncaught rejection that takes out the listener and
 * leaves the screen frozen on stale data with nothing in the UI to say so.
 */
export async function openDoc(collection, data) {
  if (!policyFor(collection) || data == null) return data

  // Not awaited: resolverFor is synchronous and fetches keys only if a value
  // turns out to be sealed. A document with nothing encrypted on it must not
  // cost a callable round trip.
  const resolve = resolverFor()
  const cache = contentKeyCache()
  const restricted = []

  const out = await mapSealed(collection, data, async (fieldPath, value) => {
    try {
      return await openValue(resolve, fieldPath, value, cache)
    } catch (e) {
      if (e instanceof SealedValueError && e.reason === 'restricted') {
        // The designed outcome for a reader without the key. Recorded, not
        // reported: an auditor's every page view would otherwise fill Sentry.
        restricted.push(fieldPath)
        return OMIT
      }
      // Corruption is never normal. A value that claims to be an envelope and
      // fails its authentication tag means it was altered, moved from another
      // field, or sealed for another organization — all of which are worth
      // waking somebody for, and none of which should put the value on screen.
      reportError(e, { source: 'crypto.openDoc', collection, fieldPath })
      restricted.push(fieldPath)
      return OMIT
    }
  })

  if (restricted.length && out && typeof out === 'object') {
    // Deduped: `capa[].owner` on a twelve-row array is one restriction, not
    // twelve, and a screen showing the list should say so once.
    out[RESTRICTED_KEY] = [...new Set(restricted)]
  }
  return out
}

/** The same, for a list, sharing one content-key cache across the batch. */
export async function openDocs(collection, list) {
  if ((!Array.isArray(list) || !policyFor(collection))) return list
  // No pre-warm. Fetching the keyring up front here would undo the laziness in
  // resolverFor and put a callable round trip in front of every list, sealed or
  // not — which is the regression this shape exists to prevent. The first
  // sealed value in the batch fetches; loadKeys caches the PROMISE, so the rest
  // await that one call rather than racing it.
  return Promise.all(list.map((d) => openDoc(collection, d)))
}

/**
 * Wrap an onSnapshot callback so it receives OPENED rows.
 *
 * Every live listener in this app needs the same three things and gets two of
 * them wrong if written by hand:
 *
 *   · decryption is async and onSnapshot's callback is not, so the rows have to
 *     be delivered from a promise;
 *   · a busy collection re-emits faster than a large batch decrypts, and two
 *     in-flight batches can resolve in the wrong order — delivering an older
 *     list on top of a newer one. The sequence guard drops any batch that is no
 *     longer the latest, which is why the counter is here and not in openDocs;
 *   · the unsubscribe must still be returned SYNCHRONOUSLY, which it is,
 *     because this only wraps the callback and never the subscribe.
 *
 * Usage: `onSnapshot(q, openSnapshots(orgId, 'injuries', (rows) => cb(rows), map))`
 * where `map` turns the QuerySnapshot into plain rows.
 */
export function openSnapshots(collection, cb) {
  let latest = 0
  return (rows) => {
    const mine = latest + 1
    latest = mine
    openDocs(collection, rows).then((opened) => {
      if (mine === latest) cb(opened)
    })
  }
}

/** Did anything have to be hidden from this reader? */
export const isRestricted = (doc, field) => {
  const list = doc?.[RESTRICTED_KEY]
  if (!Array.isArray(list)) return false
  return field ? list.some((p) => p === field || p.endsWith(`.${field}`) || p.endsWith(`[].${field}`)) : list.length > 0
}

// ── Files ────────────────────────────────────────────────────────────────────

/**
 * Seal file bytes for a collection, returning what to store on the pointer.
 *
 * `{ bytes, meta }` — upload `bytes`, spread `meta` onto the pointer document.
 * Returns `{ bytes, meta: null }` unchanged when the collection seals no files
 * or sealing is off, so callers have one code path.
 *
 * The pointer carries the IV and the wrapped key rather than the object doing
 * so, which means a reader refused the key learns it from a 300-byte document
 * instead of after downloading eight megabytes it cannot open.
 */
export async function sealFileBytes(collection, bytes) {
  const policy = policyFor(collection)
  if (!policy?.files || !sealingEnabled) return { bytes, meta: null }

  const sealer = await sealerFor(policy.keyClass)
  if (!sealer) return { bytes, meta: null }

  const sealed = await sealer.sealFile(fileLabel(policy.keyClass), bytes)
  return {
    bytes: sealed.bytes,
    // `enc` prefixes so these cannot collide with a field the app already
    // stores on a pointer, and so a glance at a document says whether its
    // object is sealed.
    meta: {
      encScheme: sealed.scheme,
      encKeyId: sealed.keyId,
      encIv: sealed.iv,
      ...(sealed.wrapped ? { encWrapped: sealed.wrapped } : {}),
    },
  }
}

/** Is this pointer's object sealed? Absent metadata means a file from before. */
export const isSealedFile = (pointer) => Boolean(pointer?.encIv && pointer?.encKeyId)

/**
 * The plaintext bytes of a stored object.
 *
 * Passes unsealed bytes straight through, so a gallery mixing files uploaded
 * before and after the switch needs no branch of its own — the same property
 * openDoc has for fields, and for the same reason.
 *
 * Throws SealedValueError('restricted') when this reader has no key. That is
 * deliberately LOUDER than the field case: a redacted field can be left off a
 * screen, but a file the viewer asked to open cannot silently show nothing —
 * they clicked it, and they need to be told they are not allowed to see it.
 */
export async function openFileBytes(collection, pointer, bytes) {
  if ((!isSealedFile(pointer))) return bytes

  const policy = policyFor(collection)
  if (!policy) return bytes

  const scheme = pointer.encScheme || SCHEME
  const resolve = resolverFor()
  const key = await resolve(pointer.encKeyId, scheme)
  return openBytes(
    key,
    fileLabel(policy.keyClass),
    { scheme, iv: pointer.encIv, wrapped: pointer.encWrapped },
    bytes,
    contentKeyCache(),
  )
}
