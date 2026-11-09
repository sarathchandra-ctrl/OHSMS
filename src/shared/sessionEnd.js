import { currentAccessToken } from './auth/ownStackSession'

/**
 * Did this listener error just mean the session ended?
 *
 * Signing out does not close the live listeners first — the session token is
 * dropped, every open snapshot is refused at once, and each one reports
 * permission-denied. The app was logging ten "read failed" warnings on the way
 * out of a normal sign-out, one per collection the screen had open.
 *
 * That is not a permissions fault, and printing it as one is expensive in a way
 * that is easy to miss: it teaches whoever reads that console to scroll past a
 * message which, at any other moment, means a rule is wrong and a safety module
 * is showing an empty list to someone who should be seeing rows. The sites
 * listener already made this distinction; this is that reasoning, shared.
 *
 * Narrow on purpose. permission-denied WITH somebody still signed in stays a
 * fault and is still reported loudly — that is the case worth keeping.
 *
 * Returns true and notes it at debug level, so callers read as:
 *
 *     if (isSessionEnd('mock drills', err)) return
 *
 * @param {string} label what the listener was reading, for the debug line
 */
export function isSessionEnd(label, err) {
  if (err?.code !== 'permission-denied' || currentAccessToken()) return false
  // eslint-disable-next-line no-console
  console.debug(`[OHS MS] ${label} listener closed with the session`)
  return true
}
