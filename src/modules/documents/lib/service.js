// ─────────────────────────────────────────────────────────────────────────────
// The documents service: the generic module service, with reads narrowed.
//
// Writes, audit logging and doc-id reservation are unchanged — they come
// straight from createModuleService. Only `subscribe` is replaced, because a
// site-scoped library cannot ask for the whole collection any more. See
// readScope.js for why, and firestore.rules for the rule it mirrors.
// ─────────────────────────────────────────────────────────────────────────────

import { collection, query, where, orderBy, limit, onSnapshot } from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { createModuleService } from '../../../shared/module-kit/service'
import { incompleteReadNotice } from '../../../shared/org/orgData'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { readPlan, mergeResults } from './readScope'

export const MAX = 1000

const base = createModuleService('documents', 'documents')

/**
 * The "these figures are incomplete" notice for a set of per-query statuses.
 *
 * One viewer runs SEVERAL queries — the org-wide slice plus one per batch of
 * thirty sites — so a cap is per query, not per read. They are labelled by
 * position rather than by filter: "siteId in (…30 ids…)" is not a thing to put
 * on a dashboard, and the reader only needs to know that a slice was short.
 *
 * Returns null while everything is whole, so a caller can render it
 * unconditionally.
 */
export function readNotice(status = []) {
  return incompleteReadNotice(
    Object.fromEntries(
      status.map((s, i) => [status.length === 1 ? 'documents' : `documents (part ${i + 1})`, s])
    ),
    MAX
  )
}

export const documentsService = {
  ...base,

  /**
   * @param viewer { role, sites } — sites being the ones already visible to
   *        them, so the query can never ask for a site the rule would refuse.
   *
   * The callback is `cb(rows, incomplete)`. `incomplete` is null while the read
   * is whole and otherwise carries the message to put on screen.
   *
   * That second argument exists because this read is CAPPED, and a capped read
   * is indistinguishable from a short one. The browser survives it — a document
   * off the end of the list is a document you scroll for. A COUNT does not: the
   * pre-launch readiness figure divides by a fixed thirty-five per site, so a
   * certificate that fell off the end is reported as one nobody filed, and the
   * screen says a site is behind when it is not. A reader cannot tell those two
   * apart, so the read has to.
   */
  subscribe(cb, viewer = {}) {
    const col = collection(db, 'documents')
    const plan = readPlan(viewer.role, viewer.sites)

    // Each query keeps its own slot, so a late snapshot from one cannot drop
    // the rows another has already delivered.
    const parts = plan.map(() => null)
    // 'capped' when a query came back exactly full — Firestore cannot say
    // whether more was waiting, so a full page is treated as short. It over-
    // warns on an org holding exactly 1,000, which is the safe direction.
    const status = plan.map(() => 'ok')
    // Nothing is emitted until EVERY query has answered once.
    //
    // A site-scoped viewer runs the org-wide slice plus one query per batch of
    // thirty sites, and the caller treats its first non-null callback as "the
    // library has loaded" — it renders skeletons until then. Emitting on the
    // first snapshot cleared those while the other queries were still out, so a
    // partial library presented itself as a complete one, and the documents
    // missing from it were exactly the site-scoped ones the extra queries
    // exist to fetch. A short list that announces itself as finished is worse
    // than a slow one.
    //
    // A failed query counts as answered — its error branch fills the slot and
    // emits — so one broken listener cannot hold the whole library at skeletons.
    const answered = plan.map(() => false)
    const emit = (i) => {
      answered[i] = true
      if (answered.some((a) => !a)) return
      cb(mergeResults(parts), readNotice(status))
    }

    const unsubs = plan.map((p, i) => {
      const q = p.field
        ? query(col, where(p.field, p.op, p.value), orderBy('createdAt', 'desc'), limit(MAX))
        : query(col, orderBy('createdAt', 'desc'), limit(MAX))

      return onSnapshot(
        q,
        (snap) => {
          parts[i] = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          status[i] = snap.docs.length >= MAX ? 'capped' : 'ok'
          emit(i)
        },
        (err) => {
          // The generic service turns a read failure into an empty list, which
          // is how a broken query reads as an empty library. A permission
          // refusal is the viewer not being allowed this slice — empty, quiet.
          // Any other failure still has to say so, and let the other queries
          // keep their rows.
          parts[i] = []
          if (isPermissionDenied(err)) {
            status[i] = 'denied'
            emit(i)
            return
          }
          // eslint-disable-next-line no-console
          console.error(
            `[Documents] ${p.field ? `${p.field} ${p.op}` : 'unfiltered'} listener failed:`,
            err?.message || err
          )
          status[i] = 'failed'
          emit(i)
        }
      )
    })

    return () => unsubs.forEach((u) => u && u())
  },
}
