// ─────────────────────────────────────────────────────────────────────────────
// The keys this tab holds, and what happens when it holds none.
//
// One fetch per session, from the getDataKeys callable, cached in a module
// variable for the life of the tab. Never localStorage, never IndexedDB, never
// a cookie: a key in site storage outlives the tab, the sign-out and the browser
// restart, which would quietly undo the session-scoped auth persistence this app
// chose on purpose (browserSessionPersistence in shared/firebase.js) — the
// session would end and the means to read every sealed field would still be
// sitting on the disk of a shared site laptop.
//
// The imported CryptoKeys are non-extractable, so the realistic browser-side
// theft — a script that finds this module's cache and posts what it holds — gets
// handles it cannot serialise rather than the keys themselves.
//
// ── The switch, and why it governs writes only ───────────────────────────────
//
// VITE_ENCRYPTION turns SEALING on. Opening is always attempted, whatever the
// switch says, and that asymmetry is the whole rollout story:
//
//   · off → new writes are plaintext, old sealed values still decrypt. This is
//     the DEFAULT, so this code can be merged and deployed before the master
//     secret exists or the callable is live, and nothing changes for anybody.
//   · on  → new writes are sealed, everything decrypts.
//   · on, then off again → still readable. Turning it off is a valid rollback
//     and does not strand a single record, which is the property that makes
//     turning it on a decision somebody can reverse at 3am.
//
// A switch that gated reads as well would make its own rollback destructive, and
// that is exactly the sort of switch nobody dares touch.
//
// ── What happens with no keys ────────────────────────────────────────────────
//
// Writing REFUSES. It does not fall back to plaintext, because a fallback that
// writes the cleartext of a medication into a field the policy says is sealed is
// the silent failure this whole exercise exists to prevent — and it would look
// exactly like success. The refusal names the field class and tells the person
// to reload, which is recoverable; a plaintext write is not.
//
// Reading DEGRADES. A value this reader has no key for is dropped from the
// document (policy.js OMIT), so an auditor opening an injury record sees it with
// the clinical columns absent rather than an error page. That is the normal,
// designed outcome for a role that is meant to be refused, and it must not be
// reported as a fault.
//
// The offline case falls out of the caching. Keys are fetched at sign-in, while
// the session is by definition online; a tab that then goes into a dead spot on
// site WiFi keeps sealing from memory and Firestore keeps queuing the writes.
// Only a session that STARTS offline has no keys, and such a session cannot
// reach Firestore either.
// ─────────────────────────────────────────────────────────────────────────────
import { getDataKeys } from '../functions'
import { reportError } from '../monitoring'
import {
  importKey,
  importWrapPublicKey,
  importWrapPrivateKey,
  sealValue,
  sealBytes,
  hybridSealer,
  SCHEME,
  HYBRID_SCHEME,
} from './envelope'
import { GENERAL, MEDICAL, isHybridClass } from './policy'

const clean = (v) => (v == null ? '' : String(v).trim().toLowerCase())

/**
 * Sealing is opt-in per environment. See the header: reads never consult this.
 *
 * Read once at module load rather than per call, so it cannot change halfway
 * through a save and leave half a document sealed.
 */
export const sealingEnabled = clean(import.meta.env.VITE_ENCRYPTION) === 'on'

/** Thrown when a write needs a key this tab does not have. */
export class NoKeyError extends Error {
  constructor(keyClass) {
    super(
      keyClass === MEDICAL
        ? 'Health records cannot be saved because this session has no encryption key. Reload the page and sign in again.'
        : 'This record cannot be saved because this session has no encryption key. Reload the page and sign in again.',
    )
    this.name = 'NoKeyError'
    this.keyClass = keyClass
  }
}

// ── The cache ────────────────────────────────────────────────────────────────
//
// Keyed by orgId and holding the PROMISE, not the result. Twenty listeners come
// up at once when a page mounts and every one of them wants a key; caching the
// resolved value would let all twenty call the callable before the first
// returned. Caching the promise means one call and twenty awaits.

let cached = null // { orgId, promise }

/**
 * Unwrapped content keys, keyed by their wrapped form.
 *
 * Session-scoped rather than per-read, because a live list re-emits on every
 * change anybody in the organization makes and re-decrypting it each time would
 * be the dominant cost on the page. Every field of one document write shares a
 * wrapped key (hybridSealer), so a document contributes roughly one entry per
 * save generation rather than one per field.
 *
 * Bounded, because it is never invalidated by anything but sign-out and an
 * unbounded map keyed by ciphertext grows with everything the session has ever
 * looked at. When it fills it is emptied wholesale rather than evicted one at a
 * time: the cost of a miss is 0.6ms and the cost of maintaining an LRU on every
 * hit is paid on every field of every record.
 */
const CEK_CACHE_MAX = 2000
let cekCache = new Map()

export function contentKeyCache() {
  if (cekCache.size > CEK_CACHE_MAX) cekCache = new Map()
  return cekCache
}

/**
 * Every key this session holds, imported and ready.
 *
 * Shape: `{ general?: { keyId, key }, medical?: { keyId, publicKey, privateKey? } }`
 * where each key is a CryptoKey. A class the caller is not entitled to is
 * absent, and `medical.privateKey` absent while `medical.publicKey` is present
 * is the ordinary member: able to seal a health record, unable to open one.
 *
 * Never rejects. A callable that is not deployed, a network that is down, a
 * refusal for an unapproved account — all of them come back as {}, because the
 * two callers of this both have a correct behaviour for "no keys" (refuse the
 * write, redact the read) and neither has one for an exception thrown out of a
 * Firestore snapshot handler.
 */
export async function loadKeys(orgId) {
  if (!orgId) return {}
  if (cached?.orgId === orgId) return cached.promise

  const promise = (async () => {
    let raw
    try {
      raw = await getDataKeys()
    } catch (e) {
      // Expected before the callable is deployed and while a member is pending
      // approval. Reported, not thrown: see the note above.
      reportError(e, { source: 'crypto.loadKeys' })
      return {}
    }

    const out = {}
    try {
      if (raw?.general?.key) {
        out.general = { keyId: raw.general.keyId, key: await importKey(raw.general.key) }
      }
      if (raw?.medical?.publicKey) {
        out.medical = {
          keyId: raw.medical.keyId,
          publicKey: await importWrapPublicKey(raw.medical.publicKey),
        }
        if (raw.medical.privateKey) {
          out.medical.privateKey = await importWrapPrivateKey(raw.medical.privateKey)
        }
      }
    } catch (e) {
      // A key that arrived but will not import is a real defect — a format
      // disagreement between stack/lib/dataKeys.js and envelope.js — and
      // must not be quietly downgraded to "this user has no keys".
      reportError(e, { source: 'crypto.loadKeys.import' })
    }
    return out
  })()

  cached = { orgId, promise }
  return promise
}

/**
 * Drop everything. Called on sign-out and on any change of organization.
 *
 * Not merely hygiene: without it, signing out and signing in as a colleague with
 * fewer rights on the same machine would leave the previous session's medical
 * private key in memory, and the new session would decrypt records its own role
 * is refused. The keys are non-extractable, so this is the only way they go.
 */
export function clearKeyring() {
  cached = null
  // The content keys go too. They are derived from the medical private key, so
  // leaving them behind would let the next session on this machine open the
  // previous one's health records without ever holding the key that opens them.
  cekCache = new Map()
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * A resolver for openValue: `(keyId, scheme) => CryptoKey | null`.
 *
 * Matches on the key CLASS embedded in the id rather than on the id itself, so
 * a value sealed under `medical.1` still opens for a session holding `medical.2`
 * only if the ids agree — they must, because a rotated key is a different key.
 * The check is explicit rather than implied by the class so that a future
 * rotation cannot silently return the wrong key and report the failure as
 * corruption.
 *
 * Returns null, never throws. Null means "redact"; openValue turns it into a
 * SealedValueError with reason 'restricted', and the document layer drops the
 * field.
 */
export function resolverFor(orgId) {
  // SYNCHRONOUS, and the keys are fetched inside the returned function rather
  // than here. That is the difference between "this app calls getDataKeys once
  // per session" and "this app calls getDataKeys on every screen that reads a
  // covered collection, whether or not anything on it is encrypted".
  //
  // openValue only consults a resolver when it has actually parsed an envelope,
  // so with this shape an organization holding no sealed data never asks for a
  // key at all. Before it, opening any incident fetched keys eagerly — and in
  // an environment where the callable is not deployed (a fresh project, the
  // emulator, the Playwright smoke run) that failed and reported an error on
  // every route. It also meant every tenant paid a callable round trip to
  // decrypt nothing.
  return async (keyId, scheme) => {
    const keys = await loadKeys(orgId)
    if (scheme === HYBRID_SCHEME) {
      // The member's case: they hold medical.publicKey and no privateKey, so
      // this is null and the clinical fields are redacted — which is precisely
      // what firestore.rules already says about them.
      return keys.medical?.keyId === keyId ? keys.medical.privateKey || null : null
    }
    if (scheme === SCHEME) {
      return keys.general?.keyId === keyId ? keys.general.key : null
    }
    return null
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * A sealer for one key class, or null when sealing is switched off.
 *
 * Returns `{ keyId, seal(fieldPath, value), sealFile(label, bytes) }`. Null is
 * the "write it in the clear" answer and is only ever produced by the switch —
 * a MISSING key throws NoKeyError instead, because those two situations must not
 * look alike at the call site. One is a deployment that has not turned
 * encryption on yet; the other is a session that should not be writing health
 * records at all.
 */
export async function sealerFor(orgId, keyClass) {
  if (!sealingEnabled) return null

  const keys = await loadKeys(orgId)
  const hybrid = isHybridClass(keyClass)
  const entry = hybrid ? keys.medical : keys.general
  const key = hybrid ? entry?.publicKey : entry?.key
  if (!entry || !key) throw new NoKeyError(keyClass)

  // One sealer per call, and the caller makes one call per document write — so
  // the hybrid content key is minted once and shared by every field of that
  // write. See hybridSealer in envelope.js for the measurement behind it: a key
  // per field would cost a manager about nine seconds of RSA on a large injury
  // list, every time the list re-rendered.
  if (hybrid) return hybridSealer(key, entry.keyId, orgId)

  return {
    keyId: entry.keyId,
    seal: (fieldPath, value) => sealValue(key, entry.keyId, orgId, fieldPath, value),
    sealFile: (label, bytes) => sealBytes(key, entry.keyId, orgId, label, bytes),
  }
}

/**
 * Can this session open the given class? Used by screens that want to say
 * "restricted" rather than render a record with holes in it and no explanation.
 */
export async function canOpen(orgId, keyClass) {
  const keys = await loadKeys(orgId)
  return isHybridClass(keyClass) ? Boolean(keys.medical?.privateKey) : Boolean(keys.general?.key)
}

export { GENERAL, MEDICAL }
