// ─────────────────────────────────────────────────────────────────────────────
// Server jobs ("callables").
//
// Each one is a POST to /rpc/<name> on this installation's server
// (stack/server.mjs), carrying the session token. The server re-reads the
// caller's live profile for every job; the token proves who signed in, not
// what they may do.
//
// A job the server does not implement answers 404 "no such job", and the
// screen that asked reports it as unavailable rather than failing silently.
// ─────────────────────────────────────────────────────────────────────────────
import { currentAccessToken, ownStackGateway } from './auth/ownStackSession'

/**
 * A server job, with an optional client-side deadline.
 */
async function callable(name, { timeout } = {}) {
  return async (data) => {
      const gateway = ownStackGateway()
      const token = currentAccessToken()
      const res = await fetch(`${gateway}/rpc/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data ?? {}),
        signal: timeout ? AbortSignal.timeout(timeout) : undefined,
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(body.message || 'The request was refused.')
        err.code = body.code || 'unknown'
        // The dedicated host answers a refused job with { ok: false, reason }.
        // Kept, so a screen can say why instead of "the request was refused".
        if (typeof body.reason === 'string') err.reason = body.reason
        throw err
      }
      return { data: body }
    }
}

/**
 * The signed-in member's encryption keys, as their role entitles them.
 *
 * Takes no argument on purpose: the organization, the role and therefore the
 * key classes are all read from the caller's own /users profile server-side, so
 * there is nothing in the request to tamper with.
 *
 * Returns `{ general?: {keyId, key}, medical?: {keyId, publicKey, privateKey?} }`
 * with every key base64URL-encoded. A half the caller is not entitled to is
 * ABSENT rather than null — most importantly `medical.privateKey`, which only
 * admin and manager receive, mirroring the isManagerOf gate on /injuries.
 *
 * Called once per session by shared/crypto/keyring.js, which holds the result in
 * memory only. Nothing persists these to localStorage or IndexedDB: a key in
 * site storage outlives the tab, the sign-out and the browser restart, which
 * would make the session-scoped auth persistence this app deliberately chose
 * (browserSessionPersistence, shared/firebase.js) meaningless for the data.
 */
export async function getDataKeys() {
  const fn = await callable('getDataKeys')
  return (await fn()).data
}

/**
 * Replace the signed-in user's password (and lift mustChangePassword).
 * The server reads the uid from the session and checks `current` first.
 * Resolves `{ ok, reason? }`; a refusal arrives as a thrown error with
 * `.reason` ('current-rejected', 'policy', 'stale').
 */
export async function completePasswordChange({ current, password } = {}) {
  const fn = await callable('completePasswordChange')
  return (await fn({ current, password })).data
}

/**
 * Admin: add a person with a temporary password they must replace at first
 * sign-in. Refusals carry `.reason`: 'email', 'role', 'policy',
 * 'already-member', 'not-admin'.
 */
export async function createMember({ email, name, role, password } = {}) {
  const fn = await callable('createMember')
  return (await fn({ email, name, role, password })).data
}

/** Admin: give someone a new temporary password, to change at next sign-in. */
export async function resetMemberPassword({ uid, password } = {}) {
  const fn = await callable('resetMemberPassword')
  return (await fn({ uid, password })).data
}

export async function deleteOrgFile(path) {
  const fn = await callable('deleteOrgFile')
  return (await fn({ path })).data
}

/**
 * Everything this organization holds about one person — a subject access request.
 *
 * Manager-only server-side, and scoped to the caller's own organization: the
 * subject must be a member of it, because a uid is not a secret and an export
 * keyed on one would otherwise reach across tenants.
 *
 * Read what comes back carefully, because it has two halves that mean different
 * things. `records` is COMPLETE — everything joined by a key. `mentions` is a
 * list of PLACES TO LOOK, not results: a person's name is also free text inside
 * array objects (`affectedPersonnel[].name`, `attendees[].name`), which
 * Firestore cannot query. Presenting those as "none found" would make an
 * incomplete response look authoritative.
 *
 * Pass `encryptionOn` so the reply can say whether a scan of those fields could
 * have read anything at all — over sealed data it would return zero matches,
 * which is indistinguishable from a person who is genuinely not mentioned.
 */
export async function exportSubjectData({ uid, personId, encryptionOn } = {}) {
  const fn = await callable('exportSubjectData')
  return (await fn({ uid, personId, encryptionOn })).data
}

// ── ODIN / Metabase ─────────────────────────────────────────────────────────
//
// Everything here goes through a callable rather than fetching Metabase from
// the browser, for two reasons that both have to hold.
//
// The API key is a bearer credential for the whole analytics warehouse. Handing
// it to a browser hands it to everyone who can open a tab, and no Firestore
// rule can take it back — so it stays server-side, and none of these functions
// can return it. metabaseSettings() reads the connection back for an admin with
// the key REMOVED (stack/lib/metabase.js redactConfig), not masked.
//
// The second reason is duller and just as binding: a browser cannot call a
// self-hosted Metabase at all unless that instance sets CORS headers for this
// origin, which is an operator's problem in somebody else's infrastructure.

/** The connection settings for the admin screen — never the key. */
export async function metabaseSettings() {
  const fn = await callable('metabaseConfig')
  return (await fn()).data
}

/**
 * Try the connection and say what happened, in words an admin can act on.
 *
 * Pass `{ baseUrl, apiKey }` to test a key BEFORE saving it — that value is
 * used for the one request and written nowhere. Pass `sourceId` to say WHICH
 * configured instance is being tested, so a row whose key box is empty is
 * tested with the key that instance would actually use. Pass nothing to test
 * the first stored source.
 *
 * Resolves either way: `{ ok, message }`. A failed connection test is an
 * ANSWER, not an exception — it is the entire output of pressing the button.
 */
export async function metabaseTestConnection({ baseUrl, apiKey, sourceId } = {}) {
  const fn = await callable('metabaseTest')
  return (await fn({ baseUrl, apiKey, sourceId })).data
}

/**
 * Run one of the configured saved questions.
 *
 * `dataset` is a NAME ('findings' | 'audits'), never a card id: the only
 * questions reachable are the ones an admin of this organization put in the
 * settings, so a caller cannot point this at another question in the instance.
 *
 * Resolves to `{ ok: true, rows, unmapped, total, capped, sources, fetchedAt }`,
 * or to `{ ok: false, reason, message, sources }` — 'not-configured',
 * 'no-card', 'unreachable', 'refused', 'query-failed'. Those are different
 * screens in the tab, and the person reading one needs to know which thing to
 * ask an admin for, so they come back as data rather than as one
 * undifferentiated throw.
 *
 * When more than one instance is configured, the rows are MERGED and each
 * carries `sourceId`/`sourceLabel`. `sources` reports each instance's outcome
 * whether it succeeded or not, so "these figures are from two of your three
 * instances" is a caveat the dashboard can actually print. `ok` is true when at
 * least one answered: a single instance being down must not blank a dashboard
 * the others can fill.
 *
 * ── The range ────────────────────────────────────────────────────────────────
 *
 * `{ from, to }` as 'YYYY-MM-DD' runs the question over that window, bound to
 * whatever date parameters the saved question declares. This is not an
 * optimisation: a question with REQUIRED date variables — which serious ones
 * usually have — cannot be run without them and answers "missing required
 * parameters" to anything else. It also means the warehouse does the filtering,
 * instead of a year of rows crossing the wire so the browser can throw most of
 * them away.
 *
 * Omit it for the last twelve months. The response echoes `range` (what
 * actually ran, after clamping) and `bound` (which of the question's parameters
 * received it), because a figure that disagrees with Metabase is nearly always
 * the two having been asked different questions.
 */
export async function metabaseQuery(dataset, { from, to } = {}) {
  // Five minutes, matching the callable's own budget. The server waits up to
  // 100s on Metabase and retries once on a server error, so a client that gave
  // up at the default 70s would report a failure for a query still running —
  // and would abandon the retry that exists to rescue it.
  const fn = await callable('metabaseQuery', { timeout: 300_000 })
  return (await fn({ dataset, from, to })).data
}

/**
 * WhatsApp site lookup: the caller's own link status.
 *
 * `{ available, number, linked, masked, linkedAt }`. The waLinks collection is
 * server-only (firestore.rules), so this callable — which answers only about
 * the caller, with the number masked to its last four digits — is the one way
 * the app can see it.
 */
export async function whatsAppLinkStatus() {
  const fn = await callable('whatsAppLinkStatus')
  return (await fn()).data
}

/**
 * Issue a one-time code to send from the phone as "LINK 123456".
 * `{ code, expiresAtMs, number }`. Sending it from WhatsApp is the proof that
 * the number belongs to the signed-in person.
 */
export async function startWhatsAppLink() {
  const fn = await callable('startWhatsAppLink')
  return (await fn()).data
}

/** Withdraw consent: remove the caller's linked number. `{ removed }`. */
export async function unlinkWhatsApp() {
  const fn = await callable('unlinkWhatsApp')
  return (await fn()).data
}

/**
 * Org Settings → Connect with WhatsApp. The caller's organisation is read
 * server-side; nothing here names a token, a secret, or an organisation id.
 *
 * `{ platformReady, number, chatLink, enabled, links, truncated }`. `links`
 * are the handsets allowed to query this organisation. `chatLink` is the
 * shared number's wa.me URL, or null when that number is not published.
 */
export async function whatsAppOrgStatus() {
  const fn = await callable('whatsAppOrgStatus')
  return (await fn()).data
}

/** `{ enabled }` — turn lookup on or off for the caller's organisation. */
export async function setWhatsAppOrgEnabled(enabled) {
  const fn = await callable('setWhatsAppOrgEnabled')
  return (await fn({ enabled: enabled === true })).data
}

/**
 * Attach a handset to an employee. `uid` may be omitted to match a profile
 * that already stores this number. `{ phone, masked, uid, mapped }`.
 */
export async function addWhatsAppOrgNumber({ phone, uid } = {}) {
  const fn = await callable('addWhatsAppOrgNumber')
  return (await fn({ phone, uid: uid || null })).data
}

/** Remove a handset linked to the caller's organisation. `{ masked }`. */
export async function removeWhatsAppOrgNumber(phone) {
  const fn = await callable('removeWhatsAppOrgNumber')
  return (await fn({ phone })).data
}

/** Send one test to a number already linked to the caller's organisation. `{ sent, masked }`. */
export async function sendWhatsAppOrgTest(phone) {
  const fn = await callable('sendWhatsAppOrgTest')
  return (await fn({ phone })).data
}

/**
 * Current conditions near a coordinate, from Open-Meteo via Cloud Functions.
 *
 * The browser calls this function only. It does not call Open-Meteo, and there
 * is no weather API key in the client. This returns the normalised observation,
 * or `{ obs: null }` when the provider did not answer. `{ limited: true }`
 * means the provider asked us to wait.
 */
export async function fetchSiteWeather({ lat, lng } = {}) {
  const fn = await callable('fetchSiteWeather')
  return (await fn({ lat, lng })).data
}
