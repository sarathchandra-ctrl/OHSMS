// Jobs that have to exist before an own-stack tenant is served.
//
// They read the live profile. A uid in the body is ignored. The master key
// is the argument the host passes from its secret store, never from the
// request. Retention does not grow a scheduler that deletes statutory records:
// planLiveAgePurge stays empty while the period is NEEDS_LEGAL_SIGN_OFF.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { grantsFor, generateKeyset, releaseKeyset } from '../stack/lib/dataKeys.js'
import { mayDeleteFile } from '../stack/lib/fileDelete.js'
import { planPurge } from '../stack/lib/retention.js'
import {
  planLiveAgePurge,
  RECORD_CLASSES,
  NEEDS_LEGAL_SIGN_OFF,
} from '../stack/lib/retentionPolicy.js'
import { asWorker } from './engine.mjs'
import { planWithdrawals, withdrawnFields } from '../stack/lib/permitMirror.js'
import { planFlags } from '../stack/lib/lotoPermitSweep.js'

const WORKER = { role: 'ohsms_worker', uid: '' }

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 32).toString('hex')
  return `scrypt$${salt}$${hash}`
}

function passwordMatches(stored, password) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const next = scryptSync(password, parts[1], 32)
  const got = Buffer.from(parts[2], 'hex')
  if (got.length !== next.length) return false
  return timingSafeEqual(got, next)
}

async function liveProfile(engine, uid) {
  if (!uid) return null
  return engine.get(WORKER, 'users', uid)
}

export async function stampIdentity(engine, uid) {
  const profile = await liveProfile(engine, uid)
  if (!profile || profile.status !== 'approved' || profile.mustChangePassword === true) {
    return { stamped: false }
  }
  return {
    stamped: true,
    uid,
    role: profile.role,
    status: profile.status,
    mustChangePassword: false,
  }
}

export async function completePasswordChange(
  engine,
  db,
  { uid, authTime, now = Date.now(), current, password, idp = false }
) {
  if (!uid) return { ok: false, reason: 'unauthenticated' }
  if (idp) return { ok: false, reason: 'idp' }
  if (typeof authTime === 'number' && now - authTime * 1000 > 5 * 60 * 1000) {
    return { ok: false, reason: 'stale' }
  }
  const profile = await liveProfile(engine, uid)
  if (!profile) return { ok: false, reason: 'no-profile' }
  if (profile.mustChangePassword !== true) return { ok: true, reason: 'not-required' }
  const row = await asWorker(db, 'SELECT password_hash FROM auth_secrets WHERE uid = $1', [uid])
  const stored = row.rows[0]?.password_hash
  if (!stored || !passwordMatches(stored, current)) return { ok: false, reason: 'current-rejected' }
  if (!password || password === current || password.length < 10)
    return { ok: false, reason: 'policy' }
  await asWorker(
    db,
    `INSERT INTO auth_secrets (uid, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (uid) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [uid, profile.email || uid, hashPassword(password)]
  )
  await engine.commit(WORKER, [
    {
      type: 'update',
      path: 'users',
      id: uid,
      data: { mustChangePassword: false },
    },
  ])
  return { ok: true, reason: 'replaced' }
}

export async function setLocalPassword(db, { uid, email, password }) {
  await asWorker(
    db,
    `INSERT INTO auth_secrets (uid, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (uid) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [uid, email, hashPassword(password)]
  )
}

export async function releaseDataKeys(engine, { uid, master }) {
  if (!master) return { ok: false, reason: 'no-master' }
  const profile = await liveProfile(engine, uid)
  const grants = grantsFor(profile)
  if (!grants.general) return { ok: false, reason: 'denied' }
  const path = 'meta'
  let keyset = await engine.get(WORKER, path, 'cryptoKeys')
  if (!keyset) {
    const fresh = await generateKeyset(master, 1)
    await engine.commit(WORKER, [
      {
        type: 'set',
        path,
        id: 'cryptoKeys',
        merge: false,
        data: { ...fresh, createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 } },
      },
    ])
    keyset = fresh
  }
  const stored = { ...keyset }
  delete stored.id
  const released = await releaseKeyset(master, stored, profile)
  return { ok: true, keys: released }
}

export async function deleteOrgFile(engine, blobStore, { uid, path }) {
  const profile = await liveProfile(engine, uid)
  const decision = mayDeleteFile(profile, path)
  if (!decision.ok) return decision
  if (blobStore) await blobStore.remove(path)
  return { ok: true }
}

/** Maintenance jobs are an administrator's, read from the live profile. */
export async function isLiveAdmin(engine, uid) {
  const profile = await liveProfile(engine, uid)
  return Boolean(
    profile &&
      profile.status === 'approved' &&
      profile.role === 'admin' &&
      profile.mustChangePassword !== true
  )
}

export async function runRetention(engine, { now = Date.now() }) {
  const live = []
  for (const row of RECORD_CLASSES) {
    const plan = planLiveAgePurge([{ id: 'sample' }], row, { now })
    live.push({ path: row.path, purge: plan.purge.length, period: row.proposedPeriod })
  }
  if (live.some((row) => row.period === NEEDS_LEGAL_SIGN_OFF && row.purge !== 0)) {
    throw new Error('retention: a statutory class was queued for deletion')
  }
  const docs = await engine.list(WORKER, 'incidents', {})
  const plan = planPurge(docs, { now })
  for (const item of plan.purge || []) {
    await engine.commit(WORKER, [
      { type: 'remove', path: 'incidents', id: item.id },
    ])
  }
  return { livePurged: 0, recyclePurged: (plan.purge || []).length }
}

export async function withdrawStaleMirrors(engine, { now = Date.now() } = {}) {
  const mirrors = await engine.list(WORKER, 'permitQr', {})
  const plan = planWithdrawals(
    mirrors.map((m) => ({ ...m, token: m.token || m.id })),
    { now }
  )
  const fields = withdrawnFields()
  for (const token of plan.withdraw) {
    await engine.commit(WORKER, [{ type: 'update', path: 'permitQr', id: token, data: fields }])
  }
  return { withdrawn: plan.withdraw.length }
}

export async function sweepLoto(engine, { nowMs = Date.now() } = {}) {
  const permits = await engine.list(WORKER, 'lotoPermits', {})
  let flagged = 0
  for (const permit of permits) {
    const flags = planFlags(permit, nowMs)
    if (!flags) continue
    await engine.commit(WORKER, [
      {
        type: 'update',
        path: 'lotoPermits',
        id: permit.id,
        data: { flags },
      },
    ])
    flagged += 1
  }
  return { checked: permits.length, flagged }
}

export async function productMail(mail, message) {
  if (!mail) return { sent: false, reason: 'no-smtp' }
  return mail(message)
}
