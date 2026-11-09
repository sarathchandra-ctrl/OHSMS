// ─────────────────────────────────────────────────────────────────────────────
// Per-organization module entitlements.
//
// The registry says which modules the product HAS. This says which of them a
// given organization may see and use. One document per org, at
// /moduleEntitlements/{orgId}, written only by the platform operator (see the
// matching block in firestore.rules) and read by every approved member so the
// shell knows which tiles to draw and which routes to refuse.
//
// ABSENT MEANS ENABLED, in two places and for two different reasons:
//
//   • No document at all → the full product. Every organization was in exactly
//     this state before entitlements existed, so introducing them took nothing
//     away from anyone.
//   • Document present but a key missing → that module is on. A module added to
//     the registry after an operator last saved an org would otherwise be
//     withheld from every existing tenant until someone re-saved each one, and
//     a shipped feature that nobody can see is the worse failure.
//
// Only an explicit `false` turns a module off. `normalizeEntitlement` is what
// makes that true everywhere rather than at each call site.
// ─────────────────────────────────────────────────────────────────────────────
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from '../data/client.js'
import { db } from '../db'
import { MODULES, ADDONS, OPT_IN_KEYS } from './registry'

export const ENTITLEMENTS_COLLECTION = 'moduleEntitlements'

export const entitlementRef = (orgId) => doc(db, ENTITLEMENTS_COLLECTION, orgId)

/**
 * Every key this document governs — the modules, then the add-ons.
 *
 * Add-ons are licensed identically and are simply not navigable; see ADDONS in
 * the registry. They belong in the same document because an operator granting
 * an organization its product should be doing it in one place.
 */
export const ALL_MODULE_KEYS = [...MODULES.map((m) => m.key), ...ADDONS.map((a) => a.key)]

/**
 * Keys that are OFF until switched on, inverting the rule below.
 *
 * A Set, because this is consulted once per key on every entitlement read.
 */
const optIn = new Set(OPT_IN_KEYS)

/**
 * The stored document → a complete map of every known module key to a boolean.
 *
 * Complete, so that callers never have to think about absence again: a key
 * missing from the input is `true` on the way out. Keys in the input that no
 * longer exist in the registry are dropped rather than carried, so a module
 * removed from the product cannot linger as a phantom toggle.
 */
export function normalizeEntitlement(data) {
  const stored = data && typeof data.modules === 'object' && data.modules !== null ? data.modules : {}
  return Object.fromEntries(ALL_MODULE_KEYS.map((key) => [
    key,
    // Absent means enabled for a module and DISABLED for an opt-in add-on —
    // the whole reason optIn exists. See the note on ADDONS in the registry.
    optIn.has(key) ? stored[key] === true : stored[key] !== false,
  ]))
}

/** True if `key` is enabled under `map` (a normalized map, or a raw document). */
export function isModuleEnabled(map, key) {
  if (!key) return true
  // Unknown keys are enabled: the caller is asking about something the registry
  // does not govern, and refusing it would hide a screen no operator ever
  // turned off.
  if (!ALL_MODULE_KEYS.includes(key)) return true
  // An opt-in add-on needs an explicit yes; everything else needs no explicit
  // no. Both readings are of the same stored map, so an operator toggling a row
  // on the Module access screen does the obvious thing either way.
  if (optIn.has(key)) return map?.[key] === true
  return map?.[key] !== false
}

/** The registry entries an organization may see, in registry order. */
export function enabledModules(map) {
  return MODULES.filter((m) => isModuleEnabled(map, m.key))
}

/**
 * Keys currently switched off, for a short "3 of 18 off" style summary.
 *
 * Asks isModuleEnabled rather than testing for an explicit `false`, so an
 * opt-in add-on nobody has granted counts as off — which it is. Testing the
 * stored value directly would report every add-on as ON for every organization
 * that has never been touched, which is the opposite of the truth.
 */
export function disabledKeys(map) {
  return ALL_MODULE_KEYS.filter((key) => !isModuleEnabled(map, key))
}

/**
 * Live entitlements for one organization.
 *
 * The callback receives a normalized map, and receives one on failure too. A
 * read that errors — rules changed, offline, a member whose approval was just
 * withdrawn — must not black out the product; the safe direction here is the
 * one that matches "no document means the full product".
 */
export function subscribeEntitlement(orgId, cb) {
  if (!orgId) {
    cb(normalizeEntitlement(null))
    return () => {}
  }
  return onSnapshot(
    entitlementRef(orgId),
    (snap) => cb(normalizeEntitlement(snap.exists() ? snap.data() : null)),
    () => cb(normalizeEntitlement(null))
  )
}

/**
 * Live entitlements for EVERY organization — the platform console's view.
 *
 * Emits `{ [orgId]: { map, raw, exists } }`. `exists` is kept because "this org
 * has never been configured" and "this org was configured with everything on"
 * are the same map but not the same fact, and the console says so.
 *
 * Listing this collection is refused to everyone but a platform operator, so
 * this subscription is only ever mounted behind that guard.
 */
export function subscribeAllEntitlements(cb, onError) {
  return onSnapshot(
    collection(db, ENTITLEMENTS_COLLECTION),
    (snap) => {
      const out = {}
      snap.forEach((d) => {
        out[d.id] = { exists: true, raw: d.data(), map: normalizeEntitlement(d.data()) }
      })
      cb(out)
    },
    (err) => onError?.(err)
  )
}

/**
 * Write one organization's entitlement.
 *
 * Every known key is written explicitly, including the enabled ones. Storing
 * only the exclusions would be smaller and would read the same today, but it
 * loses the difference between "the operator decided this is on" and "this key
 * did not exist when the operator last looked" — and that difference is what
 * the console shows an operator who is deciding what to change.
 */
export async function saveEntitlement(orgId, map, actor) {
  const modules = Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, map?.[key] !== false]))
  await setDoc(entitlementRef(orgId), {
    modules,
    updatedAt: serverTimestamp(),
    updatedBy: actor?.uid || '',
    updatedByEmail: actor?.email || '',
  })
  return modules
}

/** Drop the document, returning the organization to the default: everything on. */
export async function resetEntitlement(orgId) {
  await deleteDoc(entitlementRef(orgId))
}
