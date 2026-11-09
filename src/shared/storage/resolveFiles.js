// ─────────────────────────────────────────────────────────────────────────────
// Turning a list of stored file pointers into URLs a renderer can use.
//
// Every gallery in this app reads one field — `.dataUrl` — whichever era the
// file was saved in, because the data layer normalises `data.dataUrl ||
// data.url` before anything sees it. That contract is why the incident gallery,
// the drill recorder, the detail modals and all three printed PDF documents
// need no knowledge of where bytes actually live.
//
// An ENCRYPTED object breaks that contract and cannot be made to fit it: the
// bytes behind `.url` are ciphertext, and a browser handed that URL renders a
// broken image. The fix could have been to move every renderer onto a hook —
// and that was the plan recorded in policy.js — but it would have meant editing
// a dozen `<img>` tags and, worse, the three PDF paths, which are the outputs
// people rely on for compliance and the hardest thing here to test.
//
// This does it at the seam instead. The pointer list goes in, a list with usable
// `.dataUrl` values comes out, and not one renderer changes.
//
// ── The revocation, which is the whole reason this is a module ───────────────
//
// A decrypted object becomes a blob: URL, and a blob: URL pins its bytes in
// memory until it is revoked. A gallery that forgets leaks every photo the user
// scrolls past — the exact failure fileUrl's `revoke` contract exists to
// prevent, now multiplied across a list.
//
// So this returns a `revoke` alongside the rows, and the callers have somewhere
// natural to put it: a subscription already hands back an unsubscribe, so the
// previous batch is revoked when a new snapshot arrives and the last batch when
// the listener stops. Nothing is left to a component remembering.
//
// Unsealed files cost nothing here: they keep the `.url` they always had, no
// fetch happens, and `revoke` has nothing to release for them. That is what
// makes turning `files: true` on safe for history — a bucket full of
// unencrypted objects keeps rendering exactly as before, and only new uploads
// take the new path.
// ─────────────────────────────────────────────────────────────────────────────
import { fileUrl } from './index'
import { isSealedFile } from '../crypto'

/**
 * Resolve every sealed pointer in `rows` to a usable URL.
 *
 * @param rows pointers as stored, each already carrying the normalised
 *             `dataUrl` the readers expect
 * @returns `{ rows, revoke }` — call `revoke()` when the list is replaced or
 *          the screen goes away
 *
 * Failure is per-row and never fatal. A file this reader has no key for, or one
 * whose object has gone, comes back with `dataUrl: ''` and a `restricted` flag
 * rather than taking the whole gallery down: one unreadable photo must not hide
 * the other eleven, and a caller can show a padlock where the thumbnail would
 * have been.
 */
export async function resolveSealedFiles(collection, rows = []) {
  const list = Array.isArray(rows) ? rows : []
  // Nothing sealed: hand the input straight back, allocate nothing, and give
  // the caller a revoke that does nothing. This is the path every existing
  // gallery takes until the day something is uploaded under a sealed policy.
  if ((!list.some(isSealedFile))) return { rows: list, revoke: () => {} }

  const releases = []
  const resolved = await Promise.all(list.map(async (row) => {
    if (!isSealedFile(row)) return row
    try {
      const { url, revoke, restricted } = await fileUrl(row, { collection })
      if (revoke) releases.push(revoke)
      // fileUrl deliberately returns no URL for a sealed object it could not
      // open, rather than falling back to the stored one — that URL points at
      // ciphertext, and a broken image reads to a manager as "the file is
      // gone" rather than "you have no key loaded".
      return { ...row, dataUrl: url || '', restricted: Boolean(restricted || !url) }
    } catch {
      return { ...row, dataUrl: '', restricted: true }
    }
  }))

  return {
    rows: resolved,
    revoke: () => { for (const release of releases) release() },
  }
}

/**
 * The same, wired into a subscription.
 *
 * Wraps a callback so it receives resolved rows, revoking the previous batch
 * each time a new one arrives, and returns a `stop` to revoke the last one.
 *
 * The sequence guard is the same one openSnapshots needs and for the same
 * reason: resolving is asynchronous, a busy collection re-emits faster than a
 * gallery of photos decrypts, and two in-flight batches can finish in the wrong
 * order. A stale batch is dropped AND its URLs revoked immediately — dropping it
 * without revoking would leak precisely the batches nobody ever sees.
 */
export function resolveSubscription(collection, cb) {
  let latest = 0
  let release = () => {}
  let stopped = false

  const onRows = (rows) => {
    const mine = latest + 1
    latest = mine
    resolveSealedFiles(collection, rows).then((out) => {
      if (stopped || mine !== latest) { out.revoke(); return }
      release()
      release = out.revoke
      cb(out.rows)
    })
  }

  onRows.stop = () => { stopped = true; release(); release = () => {} }
  return onRows
}
