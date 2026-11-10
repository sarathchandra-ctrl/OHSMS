// ─────────────────────────────────────────────────────────────────────────────
// File storage — the seam between the app and whichever backend holds bytes.
//
// Callers deal in {url, path} and never see the backend. The backend is the
// presign endpoint (adapters/s3.js): by default this installation's own server,
// which keeps the bytes on its disk (stack/blobs.mjs). VITE_S3_PRESIGN_ENDPOINT
// can point it at another presign host in front of an S3-compatible bucket.
//
// Adding a backend = one adapter file implementing { put(path, blob) -> {url},
// remove(path) } plus a line in DRIVERS below. Nothing outside this folder
// changes — every module already calls putFile/removeFile only.
//
// putFile returns null on ANY failure — driver not configured, offline, rules
// refusal — so every caller can fall back to the old inline dataUrl and the
// app keeps working un-degraded while infrastructure catches up.
// ─────────────────────────────────────────────────────────────────────────────
import { pointerPath } from './pointerPath'
import { reportError } from '../monitoring'
import { isSealedFile, openFileBytes, sealFileBytes } from '../crypto'
import { checkFileBytes, headOf } from './sniffType'
import { runtimeEnv } from '../runtimeConfig'
import { MAX_UPLOAD_BYTES } from '../../../stack/lib/uploadLimits'

export { MAX_UPLOAD_BYTES }

/**
 * A file refused on its contents, as opposed to storage being unavailable.
 *
 * The distinction is the whole point: `putFile` returns null for the second and
 * every caller falls back to writing the bytes inline into Firestore. For a
 * file refused because it is an executable wearing a document's name, that
 * fallback would store exactly what was just refused.
 */
export class RejectedFileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RejectedFileError'
  }
}

const DRIVER = String(runtimeEnv('STORAGE_DRIVER') || 's3')
  .trim()
  .toLowerCase()

// Dynamic imports so only the selected driver's code (and its SDK) is loaded.
const DRIVERS = {
  s3: () => import('./adapters/s3.js'),
  // The GitHub Pages demo only: files in the tab's memory.
  demo: () => import('./adapters/demo.js'),
}

let adapterPromise = null
function loadAdapter() {
  if (!adapterPromise) {
    const load = DRIVERS[DRIVER] || DRIVERS.s3
    adapterPromise = load()
      .then((m) => m.default)
      .catch(() => null)
  }
  return adapterPromise
}

/** The active driver name — surfaced for diagnostics/admin screens. */
export const storageDriver = DRIVER in DRIVERS ? DRIVER : 's3'

// ── The two size limits, and why there are two ───────────────────────────────
//
// MAX_UPLOAD_BYTES is the real, user-facing limit: what a photo or document may
// be when it goes to the bucket. Storage does not care, so this is a product
// decision (bandwidth on site WiFi, and a cap so one upload cannot fill a
// screen's worth of time).
//
// MAX_INLINE_BYTES is the fallback limit. When the bucket is unavailable the
// app still accepts the file by writing it base64 INSIDE a Firestore document,
// and Firestore hard-caps a document at 1MB. Base64 inflates by ~33%, so 700KB
// of file is about as much as fits with room for the record's own fields.
//
// A file between the two is accepted when storage works and refused with a
// straight explanation when it does not — which is far better than writing a
// document that Firestore will reject with something unreadable.
export const MAX_INLINE_BYTES = 700 * 1024

/** Human size, for messages people read. */
export const formatSize = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`

/**
 * The message shown when the bucket is unavailable and the file is too big to
 * keep inline. Central so every module says the same thing.
 */
export const tooLargeForInline = (name) =>
  `${name ? `${name}: ` : ''}file storage is unavailable, so files must be under ` +
  `${formatSize(MAX_INLINE_BYTES)}. Enable Cloud Storage to upload up to ${formatSize(MAX_UPLOAD_BYTES)}.`

/**
 * A user-supplied filename made path-safe. An allowlist, not a blocklist:
 * anything outside letters, digits, dot, dash, underscore, parens and spaces
 * becomes an underscore — impossible to get wrong for characters nobody
 * thought of, including the invisible ones.
 */
export function safeFileName(name) {
  const s = String(name || 'file')
    .replace(/[^A-Za-z0-9._\-() ]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  // All-underscore results (e.g. from '???') carry no information — reset.
  return (/[A-Za-z0-9]/.test(s) ? s : 'file').slice(0, 120)
}

/**
 * Where a file lives: org-scoped so storage rules can enforce the same tenancy
 * Firestore rules do, with an entropy prefix so two "photo.jpg"s never collide.
 * `rand` is injectable for tests; production uses crypto randomness.
 *
 * This layout is backend-neutral on purpose: on S3 the same `orgs/<orgId>/…`
 * prefix is what the presign endpoint authorises against.
 */
export function storagePath(kind, fileName, rand = defaultRand) {
  if (!kind) throw new Error('storagePath needs a kind')
  // Every segment is sanitised, not only the filename. kind is a literal today,
  // but a path builder that trusts its inputs is one refactor away from a
  // traversal, and files/ is the only prefix the server will sign.
  const seg = (v) => {
    const s = String(v).replace(/[^A-Za-z0-9_-]/g, '_')
    if (!/[A-Za-z0-9]/.test(s)) throw new Error('storagePath segment carries no information')
    return s
  }
  return `files/${seg(kind)}/${rand()}-${safeFileName(fileName)}`
}

function defaultRand() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A data: URL (the app's legacy file format) as a Blob, or null if malformed. */
export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''))
  if (!m) return null
  const type = m[1] || 'application/octet-stream'
  try {
    const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3])
    // Base64 payloads are binary-safe (charCodeAt is always ≤ 255). Non-base64
    // payloads are decoded UTF-16 strings where charCodeAt can exceed 255,
    // truncating non-ASCII characters. Use TextEncoder for those.
    const bytes = m[2]
      ? Uint8Array.from(raw, (c) => c.charCodeAt(0))
      : new TextEncoder().encode(raw)
    return new Blob([bytes], { type })
  } catch {
    return null
  }
}

/**
 * Upload a File/Blob (or legacy data: URL string) and return
 * `{ url, path, size, contentType, name }` — or null, meaning "store it the
 * old way instead".
 */
export async function putFile(kind, file, fileName, { collection } = {}) {
  try {
    const blob = typeof file === 'string' ? dataUrlToBlob(file) : file
    if (!blob) return null
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new RejectedFileError(`File is too large. Max ${formatSize(MAX_UPLOAD_BYTES)}.`)
    }

    // Is this file what it says it is? (audit finding M-6, A.8.7)
    //
    // FIRST, before the adapter is even loaded, and that ordering is the
    // control rather than a tidiness. Every `return null` below means "storage
    // is unavailable" and every caller answers it by writing the bytes base64
    // into a Firestore document instead — so a check placed after the adapter
    // guard would be skipped in exactly the situation where the refused file
    // still gets stored. The first version of this sat after that guard and did
    // nothing at all when the bucket was unconfigured.
    //
    // storage.rules allow-lists the DECLARED content type, and that value comes
    // from the client — a browser guesses it from the extension, and anything
    // that is not this app sets it to whatever it likes. So the rule answers
    // "may an object be served as this type" and nothing answered "are these
    // bytes that type". An .exe named report.pdf satisfied every check there is.
    //
    // BEFORE sealing, necessarily: two lines below these bytes become AES-GCM
    // ciphertext, which matches no signature and can never be inspected again by
    // anything — not here, not by a bucket-triggered scanner, not by an
    // antivirus product. The one moment the plaintext exists on a machine we
    // control is this one.
    const verdict = checkFileBytes(await headOf(blob), blob.type || '')
    if (!verdict.ok) {
      // Thrown, not returned as null: null means "storage is unavailable, fall
      // back to inline" and every caller handles it that way — which would file
      // the refused bytes into a Firestore document instead, base64, and the
      // check would have achieved precisely nothing.
      //
      // Its own type so the catch below can tell it apart. Everything else that
      // throws in here is an infrastructure problem and SHOULD degrade to the
      // inline path; this one is a decision about the file and has to reach the
      // person who chose it.
      throw new RejectedFileError(verdict.reason)
    }

    const adapter = await loadAdapter()
    if (!adapter) return null
    const name = safeFileName(fileName || file?.name)
    const path = storagePath(kind, name)

    // Sealing is opt-in per collection (shared/crypto/policy.js) and returns the
    // bytes untouched with meta:null for everything else, so the common path is
    // unchanged. `collection` is passed by the caller rather than derived from
    // `kind` because the two are different vocabularies: `kind` is a Storage
    // path segment ('medical-records') and the policy is keyed by the Firestore
    // collection the POINTER lives in ('injuries/records'). Guessing one from
    // the other is how a file ends up sealed under the wrong class.
    const { bytes, meta } = await sealFileBytes(
      collection,
      new Uint8Array(await blob.arrayBuffer())
    )
    // Uploaded as octet-stream when sealed, so nothing downstream — a browser,
    // a thumbnailer, a virus scanner — tries to interpret ciphertext as a PDF.
    // The real type stays on the pointer for the reader to rebuild the Blob.
    const upload = meta ? new Blob([bytes], { type: 'application/octet-stream' }) : blob

    const result = await adapter.put(path, upload)
    // Success is the ADAPTER returning, not a url coming back. The firebase
    // adapter no longer mints one — a download URL is a permanent bearer
    // credential and the point of M-5 is to stop writing them down — so
    // requiring a url here would have turned every successful upload into a
    // silent failure and sent every caller down its inline-dataUrl fallback.
    //
    // `url` stays in the returned shape, empty, because dozens of callers spread
    // this into a Firestore document and readers still handle a stored url for
    // records written before paths were recorded. The s3 adapter still supplies
    // a real one: it has no `resolve`, so its publicUrl is the only way its
    // objects can be read, and that is the deploying operator's choice to make
    // at their presign endpoint rather than something to break from here.
    if (!result) return null
    return {
      url: result.url || '',
      path,
      // The ORIGINAL size and type, not the ciphertext's. Every screen that
      // prints a file size means the file the person chose, and the reader
      // needs the real type to rebuild a Blob the browser will render.
      size: blob.size,
      contentType: blob.type || '',
      name,
      ...(meta || {}),
    }
  } catch (e) {
    // A refused file is not an infrastructure failure and must not degrade to
    // the inline fallback — that would write the very bytes just refused into a
    // Firestore document. Re-thrown so the caller shows the reason.
    if (e instanceof RejectedFileError) throw e
    // Expected while the bucket/rules are not yet enabled in the console —
    // report once-per-kind noise is acceptable, silence is not.
    reportError(e, { source: 'storage.putFile', kind, driver: storageDriver })
    return null
  }
}

/**
 * Delete by path. Best-effort: an orphaned file is a cost, not a correctness bug.
 *
 * The delete is authorised by the server, which re-reads the caller's live
 * profile rather than trusting the session token (SECURITY.md S-19): a manager
 * suspended a minute ago must not be able to delete evidence.
 */
export async function removeFile(path) {
  if (!path) return
  try {
    const adapter = await loadAdapter()
    if (!adapter) return
    await adapter.remove(path)
  } catch {
    /* orphan tolerated */
  }
}

/**
 * A URL for a stored file that storage.rules actually governs.
 *
 * Prefers an authenticated fetch by `path`. Falls back to the persisted `url`,
 * which is a permanent unauthenticated bearer link — so the fallback is the
 * insecure path, taken only when the secure one cannot work:
 *   - records written before uploads recorded a `path`
 *   - a driver with no `resolve` (inline/data-URL storage has nothing to fetch)
 *   - the bucket has no CORS rule for this origin yet
 *
 * Returns `{ url, revoke }`. Callers MUST call revoke() when done: an object
 * URL pins its blob in memory until it is released, and a gallery that forgets
 * leaks every photo the user scrolls past.
 */
export { pointerPath }

export async function fileUrl(record, { collection } = {}) {
  const stored = typeof record === 'string' ? null : record?.url || null
  const path = pointerPath(record)
  if (!path) return { url: stored, revoke: () => {} }

  // A sealed object takes a different route, and MUST NOT fall back to the
  // stored URL when anything goes wrong. That URL points at the ciphertext, so
  // the fallback would render a broken image and — worse — would look to a
  // manager exactly like a record whose file had gone missing, when in fact
  // they simply have no key loaded yet. Encrypted objects fail loudly by
  // returning no URL at all; the caller shows "restricted" rather than a
  // blank frame.
  if (isSealedFile(record)) {
    try {
      const adapter = await loadAdapter()
      const blob = adapter?.resolveBlob ? await adapter.resolveBlob(path) : null
      if (!blob) return { url: null, revoke: () => {}, restricted: true }
      const plain = await openFileBytes(
        collection,
        record,
        new Uint8Array(await blob.arrayBuffer())
      )
      // The real content type is on the POINTER, not on the object: the object
      // was uploaded as application/octet-stream so nothing tries to render
      // ciphertext as a PDF.
      const url = URL.createObjectURL(
        new Blob([plain], { type: record?.type || 'application/octet-stream' })
      )
      return { url, revoke: () => URL.revokeObjectURL(url) }
    } catch (e) {
      reportError(e, { source: 'storage.fileUrl.sealed', collection })
      return { url: null, revoke: () => {}, restricted: true }
    }
  }

  try {
    const adapter = await loadAdapter()
    const resolved = adapter?.resolve ? await adapter.resolve(path) : null
    if (resolved) {
      // Only blob: URLs are ours to revoke. resolve() may return a download URL
      // when getBlob cannot run (no CORS); revoking that string is a no-op at
      // best and would be the wrong cleanup at worst.
      const revoke = String(resolved).startsWith('blob:')
        ? () => URL.revokeObjectURL(resolved)
        : () => {}
      return { url: resolved, revoke }
    }
  } catch {
    /* fall through to the stored URL */
  }

  return { url: stored, revoke: () => {} }
}
