// ─────────────────────────────────────────────────────────────────────────────
// One stored file, resolved into something an <img src> can use.
//
// `resolveFiles.js` does this for LISTS, at the data seam, so that galleries and
// the printed PDFs needed no changes. This is the other shape: a single pointer
// rendered directly by a component — a course thumbnail, an organisation logo,
// an inspection's photo evidence, a LOTO isolation point.
//
// ── Why those sites had to change at all ────────────────────────────────────
//
// They rendered `<img src={record.url}>`, and `record.url` was a Firebase
// download URL: a permanent bearer credential in a string, which works for
// anyone holding it, signed in or not, forever, with no rule ever consulted.
// The read path for sealed files moved off those long ago; the WRITE path went
// on manufacturing one for every upload and filing it in a document readable by
// every member of the tenant and by the external auditor (audit finding M-5,
// A.8.3 / A.5.14).
//
// `adapters/firebase.js` no longer mints one. That closes the creation of new
// credentials and breaks exactly these renderers, because the field they read
// is now empty — hence this hook, which asks `fileUrl()` for an authenticated
// fetch by `path` instead.
//
// ── What it does NOT do ─────────────────────────────────────────────────────
//
// It does not stop working for records written before this change. `fileUrl`
// falls back to the stored url when there is no path, or when the fetch fails
// (a bucket with no CORS rule for this origin, an object that has gone). Old
// records keep rendering exactly as they did; only new ones take the new route.
// Revoking the tokens already written down is a separate, deliberate operation
// — see `revokeDownloadTokens` in functions/index.js, which is why it defaults
// to reporting rather than revoking.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { fileUrl } from './index'

/** How many times to retry a path fetch before accepting the stored fallback. */
const MAX_ATTEMPTS = 3

/**
 * A `logoUrl` (or any pointer url) that is already the bytes.
 *
 * Data and blob URLs are not download tokens. They paint without Storage, and
 * a canvas can sample them without a bucket CORS rule. An https download URL
 * is the opposite: `getDownloadURL` can succeed and the `<img>` still fail
 * (App Check, a revoked token), and sampling it with `crossOrigin=anonymous`
 * fails closed when the bucket has no CORS rule.
 */
export function inlineImageSrc(url) {
  const s = typeof url === 'string' ? url.trim() : ''
  return s.startsWith('data:image/') || s.startsWith('blob:') ? s : ''
}

/**
 * The URL an `<img>` should use once a path fetch has answered.
 *
 * A blob: (or data:) result is the authenticated bytes — sharper than the
 * thumb, same-origin. An https result must not replace an inline thumb: that
 * replacement is how a saved logo disappeared behind a download URL the
 * header could not paint, and how theme sampling lost the only bitmap it
 * could read.
 */
export function displayFileSrc(resolved, stored) {
  const inline = inlineImageSrc(stored)
  const next = typeof resolved === 'string' ? resolved.trim() : ''
  if (next.startsWith('blob:') || next.startsWith('data:')) return next
  if (inline) return inline
  return next
}

/**
 * @param pointer   `{ url, path }`, or a bare path string, or a data: URL
 * @param options   `{ orgId, collection }` — required only for SEALED
 *                  collections, where the bytes have to be decrypted
 * @returns `{ src, loading, restricted }`
 *
 * `restricted` means the object exists and this reader may not have it — a
 * sealed file with no key loaded. It is deliberately distinct from `src: ''`,
 * because "we cannot show you this" and "there is nothing here" are different
 * things to put in front of somebody, and conflating them is how a missing
 * medical record and an unreadable one came to look identical.
 */
export function useFileUrl(pointer, { collection } = {}) {
  // The identity of a pointer, for the dependency array. An object literal
  // rebuilt on every render would re-fetch on every render — and each fetch
  // mints a blob URL, so that is a leak as well as a waste.
  const path = typeof pointer === 'string' ? pointer : pointer?.path || ''
  const stored = typeof pointer === 'string' ? '' : pointer?.url || pointer?.dataUrl || ''
  const inline = inlineImageSrc(stored)

  // An inline thumb paints on the first frame. Blanking `src` while a path
  // exists — the previous default — hid that thumb for the whole fetch, and
  // a later https download URL then replaced it permanently. A path with no
  // inline url still starts empty so a missing logo does not flash the
  // vendor mark (or a bearer download URL) before the governed fetch answers.
  const [state, setState] = useState(() => ({
    src: inline || (path ? '' : stored),
    loading: Boolean(path) && !inline,
    restricted: false,
  }))

  useEffect(() => {
    // Nothing to resolve. A data: URL is already the bytes and never had a
    // path — the inline fallback taken when the bucket was unavailable.
    if (!path) {
      setState({ src: stored, loading: false, restricted: false })
      return undefined
    }

    let live = true
    let release = () => {}
    let timer = 0
    let attempt = 0

    if (inline) setState({ src: inline, loading: false, restricted: false })

    const run = () => {
      attempt += 1
      // Keep the thumb on screen while a sharper blob is in flight. Flipping
      // `loading` here is what swapped a visible logo for an empty slot.
      if (!inline) setState((s) => ({ ...s, loading: true }))

      fileUrl(typeof pointer === 'string' ? pointer : { ...pointer }, { collection })
        .then(({ url, revoke, restricted }) => {
          release = revoke || (() => {})
          // Resolved after the component went away, or after the pointer changed:
          // release immediately rather than setting state on a dead component.
          // Without this an object URL created by a superseded fetch is pinned in
          // memory with nothing left holding a reference to revoke it.
          if (!live) {
            release()
            return
          }
          if (url) {
            setState({
              src: displayFileSrc(url, stored),
              loading: false,
              restricted: Boolean(restricted),
            })
            return
          }
          if (inline) setState({ src: inline, loading: false, restricted: Boolean(restricted) })
          // Empty result: retry a couple of times for the App Check / claims
          // races that lose the first Storage request after sign-in, then fall
          // back to whatever was persisted (logo thumb, legacy download URL).
          if (attempt < MAX_ATTEMPTS) {
            timer = window.setTimeout(run, 280 * attempt)
            return
          }
          setState({
            src: inline || stored || '',
            loading: false,
            restricted: Boolean(restricted),
          })
        })
        .catch(() => {
          if (!live) return
          if (inline) setState({ src: inline, loading: false, restricted: false })
          if (attempt < MAX_ATTEMPTS) {
            timer = window.setTimeout(run, 280 * attempt)
            return
          }
          setState({ src: inline || stored || '', loading: false, restricted: false })
        })
    }

    run()

    return () => {
      live = false
      if (timer) window.clearTimeout(timer)
      release()
    }
    // `pointer` itself is deliberately absent: callers pass object literals, and
    // depending on one would re-run this every render. path + stored are the
    // only parts that change what gets fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, stored, collection])

  return state
}

export default useFileUrl
