// The one-time creation of this installation's organization.
//
// One server, one organization. /setup (stack/server.mjs) calls this once,
// with the details typed by whoever installed the server; after that the
// organization exists and /setup is closed. The organization is a single
// document, organization/profile, and the first administrator is an invite
// for the address given: they become admin at their first sign-in through
// the identity provider connected in the same step (stack/identity.mjs).

import { applySchema, asWorker } from './engine.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }

export const ORG_PATH = 'organization'
export const ORG_ID = 'profile'

/** The organization document, or null before setup. */
export async function readOrganization(engine) {
  return engine.get(WORKER, ORG_PATH, ORG_ID)
}

/**
 * @param {object} o
 * @param {object} o.engine
 * @param {object} o.db
 * @param {string} o.orgName
 * @param {string} [o.address]
 * @param {string} o.adminEmail
 * @param {string} [o.adminName]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function initializeOrganization({
  engine,
  db,
  orgName,
  address = '',
  adminEmail,
  adminName = '',
}) {
  const name = String(orgName || '').trim()
  const email = String(adminEmail || '')
    .trim()
    .toLowerCase()
  if (!name) return { ok: false, reason: 'orgName' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: 'adminEmail' }
  await applySchema(db)
  if (await readOrganization(engine)) return { ok: false, reason: 'already-live' }
  await engine.commit(WORKER, [
    {
      type: 'set',
      path: ORG_PATH,
      id: ORG_ID,
      merge: false,
      data: { name, address: String(address || '').trim(), createdBy: 'setup' },
    },
  ])
  await asWorker(
    db,
    `INSERT INTO invites (email, role, name) VALUES ($1, 'admin', $2)
     ON CONFLICT (email) DO UPDATE SET role = 'admin', name = EXCLUDED.name`,
    [email, String(adminName || '').trim() || name]
  )
  return { ok: true }
}
