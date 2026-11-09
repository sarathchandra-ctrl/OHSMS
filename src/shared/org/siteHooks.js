// ─────────────────────────────────────────────────────────────────────────────
// Things that should happen when a site is created.
//
// Several modules want to react to a new site — CCTV needs its standard Meraki,
// and others will follow. The obvious implementation is for createSite() to call
// them directly, but that would make this shared module import feature modules,
// so the org registry could no longer be read or tested without dragging half
// the app in behind it. The dependency has to point the other way: modules
// register here, and this file knows nothing about any of them.
//
// The rule that matters: A HOOK MUST NEVER FAIL THE SITE CREATION. Adding the
// site is the thing the user asked for and it has already been written by the
// time hooks run. A CCTV record that failed to appear is recoverable — the
// inventory offers a backfill for exactly that — whereas an error thrown here
// would surface as "could not create site" for a site that now exists, and the
// retry would create it twice.
// ─────────────────────────────────────────────────────────────────────────────

const hooks = new Map()

/**
 * Register a reaction to site creation.
 *
 * Keyed by name so a module loaded twice (dev hot-reload, a lazy chunk
 * re-evaluated) replaces its hook rather than stacking a second copy — which
 * would provision everything twice on every site added.
 *
 * @param name   stable identifier for the registering module
 * @param fn     (orgId, sites, actor) => void | Promise<void>; `sites` is the
 *               array of newly created sites, each at least { id, name }
 * @returns an unregister function
 */
export function onSiteCreated(name, fn) {
  hooks.set(name, fn)
  return () => hooks.delete(name)
}

/**
 * Run every hook. Never throws, never rejects.
 *
 * Hooks run in parallel and are independent: one module failing must not stop
 * another from running, and neither may reach the caller.
 */
export async function notifySiteCreated(sites = [], actor) {
  if (!sites.length || hooks.size === 0) return
  await Promise.all(
    [...hooks.entries()].map(async ([name, fn]) => {
      try {
        await fn(sites, actor)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[site hook: ${name}] failed, site creation is unaffected:`, e?.message || e)
      }
    })
  )
}

/** Exposed for tests; nothing in the app should need it. */
export function _clearSiteHooks() {
  hooks.clear()
}
