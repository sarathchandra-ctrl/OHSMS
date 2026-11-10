// Jobs that have to exist before an own-stack tenant is served.
//
// They read the live profile. A uid in the body is ignored. The master key
// is the argument the host passes from its secret store, never from the
// request. Retention does not grow a scheduler that deletes statutory records:
// planLiveAgePurge stays empty while the period is NEEDS_LEGAL_SIGN_OFF.

import { grantsFor, generateKeyset, releaseKeyset } from '../stack/lib/dataKeys.js'
import { mayDeleteFile } from '../stack/lib/fileDelete.js'
import { planPurge } from '../stack/lib/retention.js'
import {
  planLiveAgePurge,
  RECORD_CLASSES,
  NEEDS_LEGAL_SIGN_OFF,
} from '../stack/lib/retentionPolicy.js'
import { planWithdrawals, withdrawnFields } from '../stack/lib/permitMirror.js'
import { planFlags } from '../stack/lib/lotoPermitSweep.js'
import { serveSiteWeather, WEATHER_FETCH_LIMIT, WEATHER_FETCH_WINDOW_S } from '../stack/lib/siteWeather.js'

import { planExport, planScan, scanFeasibility, classifyErasure } from '../stack/lib/subjectData.js'

export { WEATHER_FETCH_LIMIT, WEATHER_FETCH_WINDOW_S }

const WORKER = { role: 'ohsms_worker', uid: '' }

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
    await engine.commit(WORKER, [{ type: 'remove', path: 'incidents', id: item.id }])
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

// ── Site weather (fetchSiteWeather) ─────────────────────────────────────────
// The decisions are stack/lib/siteWeather.js; this wires them to the engine.
// The cache is the server-only `weatherCache` collection (policy serverOnly):
// a member who could write it would put a temperature on every screen.

const cacheId = (key) => `om_${String(key || '').replace(/[^0-9A-Za-z._-]/g, '_')}`

function weatherCacheStore(engine) {
  return {
    get: (key) => engine.get(WORKER, 'weatherCache', cacheId(key)),
    async set(key, slot, obs) {
      const plain = {}
      for (const [field, value] of Object.entries(obs || {})) {
        if (typeof value === 'number' && Number.isFinite(value)) plain[field] = value
        else if (typeof value === 'string' && value.trim()) plain[field] = value.trim()
      }
      if (!Object.keys(plain).length) return
      await engine.commit(WORKER, [
        {
          type: 'set',
          path: 'weatherCache',
          id: cacheId(key),
          merge: false,
          data: { slot, obs: plain, fetchedAt: Date.now() },
        },
      ])
    },
  }
}

export async function siteWeather(engine, { uid, data, takeRate, fetchImpl = globalThis.fetch }) {
  const profile = await liveProfile(engine, uid)
  const sites = await engine.list(WORKER, 'sites', {})
  const result = await serveSiteWeather({
    profile,
    data,
    sites,
    cache: weatherCacheStore(engine),
    fetchImpl,
    takeRate,
  })
  if (result.error) return { ok: false, code: result.error, reason: result.error, message: result.message }
  return result.body
}

// ── Subject access (exportSubjectData) ──────────────────────────────────────
// Everything this organization holds about one person. Ported from the Cloud
// Functions tier; the plan of what to gather, and what an export may NOT
// claim, is stack/lib/subjectData.js, shared with the app.
//
// Admins and managers only, judged on the live profile: the same people the
// policy lets read injuries and illnesses. Anything less would let an employee
// assemble a colleague's medical history in one call.
//
// `records` is complete for every source joined by a key. `mentions` is a list
// of PLACES TO LOOK, not results: names in free text cannot be searched
// reliably, and over sealed fields not at all (docs/DATA-RIGHTS.md §2).
// Sealed values come back sealed; the requesting manager's browser opens them.
//
// The engine's SQL filters cannot look inside a list, so each source is read
// whole and matched here. One installation is one organization, so there is
// no tenant to scope by.

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/

function joinMatches(row, q) {
  if (q.kind === 'field') return row?.[q.field] === q.value
  if (q.kind === 'arrayContains') return Array.isArray(row?.[q.field]) && row[q.field].includes(q.value)
  if (q.kind === 'arrayField') {
    return Array.isArray(row?.[q.field]) && row[q.field].some((item) => item?.[q.matchField] === q.value)
  }
  return false
}

export async function exportSubject(engine, { uid, subjectUid, personId, encryptionOn }) {
  const caller = await liveProfile(engine, uid)
  const isManager =
    caller &&
    caller.status === 'approved' &&
    caller.mustChangePassword !== true &&
    ['admin', 'manager'].includes(caller.role)
  if (!isManager) return { ok: false, reason: 'not-manager', message: 'Administrators and managers only.' }

  const who = String(subjectUid || '').trim()
  const person = String(personId || '').trim()
  if (!who && !person) return { ok: false, reason: 'no-subject', message: 'Give a uid, a personId, or both.' }
  if ((who && !SEGMENT.test(who)) || (person && !SEGMENT.test(person))) {
    return { ok: false, reason: 'invalid', message: 'That is not a valid id.' }
  }
  if (who && !(await engine.get(WORKER, 'users', who))) {
    return { ok: false, reason: 'no-subject', message: 'No person in this organization has that uid.' }
  }

  const records = {}
  const problems = []
  const read = new Map()
  for (const q of planExport({ uid: who, personId: person })) {
    try {
      if (q.kind === 'docId') {
        const row = await engine.get(WORKER, q.path, q.value)
        records[q.path] = row ? [row] : []
        continue
      }
      if (!read.has(q.path)) read.set(q.path, await engine.list(WORKER, q.path, {}))
      const found = read.get(q.path).filter((row) => joinMatches(row, q))
      // Two joins on one collection (a permit requested by them, a permit they
      // worked on) must not list the same record twice.
      const seen = new Set((records[q.path] || []).map((r) => r.id))
      records[q.path] = [...(records[q.path] || []), ...found.filter((r) => !seen.has(r.id))]
    } catch (err) {
      // A source that could not be read is reported, never silently empty.
      problems.push({ path: q.path, error: err?.message || String(err) })
    }
  }

  return {
    subject: { uid: who || null, personId: person || null },
    generatedAt: new Date().toISOString(),
    records,
    mentions: planScan(),
    scan: scanFeasibility({ encryptionOn: Boolean(encryptionOn) }),
    erasure: classifyErasure(),
    problems,
  }
}
