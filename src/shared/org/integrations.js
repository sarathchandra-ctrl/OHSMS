// ─────────────────────────────────────────────────────────────────────────────
// Third-party connection settings, one document per integration.
//
// integrations/{name}. Server-only (serverOnly in stack/policy.mjs): no browser
// session reads or writes it, admin included, because it holds credentials.
// The Metabase server job that will read it is not ported yet
// (src/shared/serverFeatures.js), so the settings screen is hidden.
//
// There is deliberately no subscribe() here, and no read helper either. The
// settings screen reads the connection back through the `metabaseConfig`
// callable, which strips the credential before it answers; a live client
// subscription would hand the browser the API key on every snapshot, which is
// exactly what the server-side design exists to avoid.
// ─────────────────────────────────────────────────────────────────────────────
import { doc, setDoc, serverTimestamp } from '../data/client.js'
import { db } from '../db'
import { logAudit } from './orgData'
import { AUDIT } from '../audit/audit'

export const integrationRef = (name) =>
  doc(db, 'integrations', name)


/**
 * Save (or update) an integration's settings.
 *
 * Merged, not replaced, so an admin who changes only the question IDs does not
 * have to re-type the API key — and so a caller can never accidentally clear a
 * credential by omitting it. Clearing is explicit: pass `apiKey: ''`.
 *
 * The audit entry names the FIELDS that changed and never their values. A
 * credential written into the append-only trail is a credential that outlives
 * every rotation of it.
 */
export async function saveIntegration(name, settings, actor) {
  await setDoc(integrationRef(name), { ...settings, updatedAt: serverTimestamp() }, { merge: true })
  await logAudit(actor, AUDIT.ORG_SETTINGS, {
    target: 'integration',
    targetId: name,
    targetLabel: name,
    summary: `Updated ${name} integration settings: ${Object.keys(settings).join(', ')}`,
  })
}
