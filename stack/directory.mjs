// The company's directory, as far as WEEHS follows it: roles taken from the
// identity provider's groups, accounts disabled when the company says so, and
// SCIM 2.0, the standard Okta, Microsoft Entra and Google use to push "this
// person was added / changed / deactivated" to every app they serve.
//
// A company whose IdP holds thousands of people should not have to mirror
// them by hand: adding someone there should be enough to let them in with the
// right role, and removing them there should be enough to shut them out here.
//
// The data API cannot reach any of this: scimUsers, scimGroups and scimTokens
// are server-only paths in schema.sql (server_only_path), and every write here
// is the worker's, after the checks below.

import { createHash, randomBytes } from 'node:crypto'
import { asWorker } from './engine.mjs'
import { INVITE_ROLES, adminOf, normalizeEmail } from './invites.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }
const refuse = (reason) => ({ ok: false, reason })

// ── Roles from groups ───────────────────────────────────────────────────────

export const MAX_GROUP_RULES = 50
// When someone is in several mapped groups, the most capable role wins.
const RANK = { admin: 4, manager: 3, member: 2, auditor: 1 }

/** [{ group, role }] as stored, dropping anything that is not one. */
export function cleanGroupRoles(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const rule of value.slice(0, MAX_GROUP_RULES)) {
    const group = typeof rule?.group === 'string' ? rule.group.trim() : ''
    if (!group || group.length > 256 || !INVITE_ROLES.includes(rule.role)) continue
    if (seen.has(group)) continue
    seen.add(group)
    out.push({ group, role: rule.role })
  }
  return out
}

/** The role the groups someone is in give them in this organization. */
export function roleFromGroups(rules, groups) {
  const mine = new Set((Array.isArray(groups) ? groups : []).map(String))
  let best = null
  for (const rule of cleanGroupRoles(rules)) {
    if (mine.has(rule.group) && (!best || RANK[rule.role] > RANK[best])) best = rule.role
  }
  return best
}

export async function getGroupRoles(engine, db, { uid }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  const org = await engine.get(WORKER, 'organization', 'profile')
  return { ok: true, rules: cleanGroupRoles(org?.groupRoles) }
}

/**
 * Admin is allowed here, unlike joining by domain: mapping a named group to
 * admin is the company deciding who its administrators are, in the place it
 * already decides it. Every rule must be valid; one that is not refuses the
 * whole save, so nothing is silently dropped.
 */
export async function setGroupRoles(engine, db, { uid, rules }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  if (!Array.isArray(rules)) return refuse('rules')
  if (rules.length > MAX_GROUP_RULES) return refuse('too-many')
  const clean = cleanGroupRoles(rules)
  if (clean.length !== rules.length) return refuse('rules')
  await engine.commit(WORKER, [
    { type: 'update', path: 'organization', id: 'profile', data: { groupRoles: clean } },
  ])
  return { ok: true, rules: clean }
}

/** An organization whose group rules let this person join, and as what. */
export async function groupJoinFor(db, groups) {
  if (!Array.isArray(groups) || !groups.length) return null
  const rows = await asWorker(
    db,
    `SELECT id, data->'groupRoles' AS rules FROM documents WHERE path = 'organization' AND id = 'profile' AND data ? 'groupRoles'`
  )
  for (const row of rows.rows) {
    const rules = typeof row.rules === 'string' ? JSON.parse(row.rules) : row.rules
    const role = roleFromGroups(rules, groups)
    if (role) return { role }
  }
  return null
}

async function approvedAdmins(db) {
  const res = await asWorker(
    db,
    `SELECT count(*)::int AS n FROM documents
      WHERE path = 'users' AND data->>'role' = 'admin' AND data->>'status' = 'approved'`,
    []
  )
  return res.rows[0]?.n ?? 0
}

/**
 * At every sign-in, the role the groups give, if they give one. Someone the
 * IdP sends no mapped group for keeps the role they have: an IdP not sending
 * groups at all must not demote everybody. And a sign-in never takes away the
 * organization's last administrator: the company could not get back in.
 */
export async function syncRoleFromGroups(engine, db, uid, profile, groups) {
  const org = await engine.get(WORKER, 'organization', 'profile')
  const role = roleFromGroups(org?.groupRoles, groups)
  if (!role || role === profile.role) return profile
  if (profile.role === 'admin' && (await approvedAdmins(db)) <= 1) return profile
  await engine.commit(WORKER, [
    { type: 'update', path: 'users', id: uid, data: { role, roleFrom: 'groups' } },
  ])
  return engine.get(WORKER, 'users', uid)
}

// ── Groups the directory pushed (SCIM Groups) ───────────────────────────────
// Okta's "Push Groups" and Entra's group provisioning send groups with their
// members. Two things follow. Someone's groups are known without a sign-in,
// so a change applies at once. And Entra, which signs people in with group
// object IDs, also pushes each group's name with that ID as externalId, so
// rules can be written with names.

async function scimGroupRows(db) {
  const res = await asWorker(db, `SELECT id, data FROM documents WHERE path = 'scimGroups'`, [])
  // A group deleted in the directory gives nobody anything from that moment.
  return res.rows
    .map((r) => ({ id: r.id, rec: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }))
    .filter(({ rec }) => !rec.deleted)
}

/**
 * The groups to apply rules to: what the sign-in carried, the names of pushed
 * groups whose ID or externalId it carried (Entra), and the pushed groups the
 * person is a member of.
 */
export async function expandGroups(db, email, claimGroups = []) {
  const out = new Set(Array.isArray(claimGroups) ? claimGroups.map(String) : [])
  const rows = await scimGroupRows(db)
  if (!rows.length) return [...out]
  const mine = await asWorker(
    db,
    `SELECT id FROM documents WHERE path = 'scimUsers' AND data->>'email' = $1 AND data->>'active' = 'true'`,
    [email]
  )
  const ids = new Set(mine.rows.map((r) => r.id))
  for (const { id, rec } of rows) {
    const named = out.has(id) || (rec.externalId && out.has(rec.externalId))
    const member = (rec.members || []).some((m) => ids.has(m))
    if ((named || member) && rec.displayName) out.add(rec.displayName)
  }
  return [...out]
}

/** Apply the rules now to these directory users' accounts, after a group changed. */
async function resyncRoles(engine, db, scimUserIds) {
  if (!scimUserIds.size) return
  const res = await asWorker(
    db,
    `SELECT id, data->>'email' AS email FROM documents WHERE path = 'scimUsers'`,
    []
  )
  const emails = new Set(res.rows.filter((r) => scimUserIds.has(r.id)).map((r) => r.email))
  for (const email of emails) {
    const accounts = await asWorker(
      db,
      `SELECT id FROM documents WHERE path = 'users'
         AND lower(data->>'email') = $1 AND data->>'status' = 'approved'`,
      [email]
    )
    const groups = await expandGroups(db, email, [])
    for (const { id } of accounts.rows) {
      const profile = await engine.get(WORKER, 'users', id)
      await syncRoleFromGroups(engine, db, id, profile, groups)
    }
  }
}

// ── Disabled ────────────────────────────────────────────────────────────────

/**
 * Deactivated by the company's directory (SCIM), whether or not they ever
 * signed in: every directory record for the address is inactive. One active
 * record (they were added back) lets them in again.
 */
export async function deactivatedByDirectory(db, email) {
  const res = await asWorker(
    db,
    `SELECT data->>'active' AS active FROM documents WHERE path = 'scimUsers' AND data->>'email' = $1`,
    [email]
  )
  return res.rows.length > 0 && res.rows.every((r) => r.active === 'false')
}

/**
 * Apply "active" to everything WEEHS holds for that address in that
 * organization. Inactive: the pending invite is withdrawn and the account is
 * disabled. The data API admits approved members only (approved_of in
 * schema.sql), so a session still open stops working at its next request,
 * not when it expires. Active again: a disabled account is approved again.
 */
async function applyActive(engine, db, email, active) {
  const users = await asWorker(
    db,
    `SELECT id, data->>'status' AS status FROM documents
      WHERE path = 'users' AND lower(data->>'email') = $1`,
    [email]
  )
  if (!active) {
    await asWorker(db, 'DELETE FROM invites WHERE email = $1', [email])
    const ops = users.rows
      .filter((u) => u.status !== 'disabled')
      .map((u) => ({
        type: 'update',
        path: 'users',
        id: u.id,
        data: { status: 'disabled', disabledBy: 'directory' },
      }))
    if (ops.length) await engine.commit(WORKER, ops)
    return
  }
  const ops = users.rows
    .filter((u) => u.status === 'disabled')
    .map((u) => ({ type: 'update', path: 'users', id: u.id, data: { status: 'approved' } }))
  if (ops.length) await engine.commit(WORKER, ops)
  if (!users.rows.length) {
    // Not signed in yet: an invite, so the first sign-in lets them in. The
    // groups, if mapped, decide the role then.
    await asWorker(
      db,
      `INSERT INTO invites (email, role, name) VALUES ($1, 'member', $1)
       ON CONFLICT (email) DO NOTHING`,
      [email]
    )
  }
}

// ── The SCIM token ──────────────────────────────────────────────────────────
// Created by an admin, shown once, kept only as a hash. One per organization;
// creating a new one replaces the old, which stops working at once.

const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex')
// One token per installation, kept under this id.
const SCIM_TOKEN_ID = 'current'

export async function scimStatus(engine, db, { uid }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  const row = await engine.get(WORKER, 'scimTokens', SCIM_TOKEN_ID)
  return { ok: true, enabled: Boolean(row?.hash), createdAt: row?.createdAt || null }
}

export async function createScimToken(engine, db, { uid }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  const token = `weehs_scim_${randomBytes(32).toString('base64url')}`
  await engine.commit(WORKER, [
    {
      type: 'set',
      path: 'scimTokens',
      id: SCIM_TOKEN_ID,
      merge: false,
      data: { hash: tokenHash(token), createdAt: new Date().toISOString(), createdBy: uid },
    },
  ])
  return { ok: true, token }
}

export async function revokeScimToken(engine, db, { uid }) {
  const admin = await adminOf(engine, uid)
  if (!admin) return refuse('not-admin')
  await engine.commit(WORKER, [{ type: 'remove', path: 'scimTokens', id: SCIM_TOKEN_ID }])
  return { ok: true }
}

/** Does the request carry this organization's current SCIM token? */
async function validScimToken(db, header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''))
  if (!m) return false
  const res = await asWorker(
    db,
    `SELECT id FROM documents WHERE path = 'scimTokens' AND id = $1 AND data->>'hash' = $2 LIMIT 1`,
    [SCIM_TOKEN_ID, tokenHash(m[1])]
  )
  return res.rows.length === 1
}

// ── SCIM 2.0 (RFC 7643, 7644): Users ────────────────────────────────────────

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

function emailOf(body) {
  const emails = Array.isArray(body?.emails) ? body.emails : []
  const primary = emails.find((e) => e?.primary) || emails[0]
  return normalizeEmail(primary?.value || '') || normalizeEmail(body?.userName || '')
}

function asBool(value) {
  return !(value === false || value === 'false' || value === 'False')
}

function textOf(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function toResource(id, rec, origin) {
  return {
    schemas: [USER_SCHEMA],
    id,
    externalId: rec.externalId || undefined,
    userName: rec.userName,
    name: { givenName: rec.givenName || '', familyName: rec.familyName || '' },
    displayName: rec.displayName || undefined,
    emails: [{ value: rec.email, primary: true, type: 'work' }],
    active: rec.active,
    meta: {
      resourceType: 'User',
      created: rec.created,
      lastModified: rec.lastModified,
      location: `${origin}/scim/v2/Users/${id}`,
    },
  }
}

function fromBody(body, prior = {}) {
  const email = emailOf(body) || prior.email
  return {
    ...prior,
    userName: textOf(body?.userName) || prior.userName || email,
    email,
    externalId: textOf(body?.externalId) || prior.externalId || '',
    givenName: textOf(body?.name?.givenName) || prior.givenName || '',
    familyName: textOf(body?.name?.familyName) || prior.familyName || '',
    displayName: textOf(body?.displayName) || prior.displayName || '',
    active: body?.active === undefined ? (prior.active ?? true) : asBool(body.active),
  }
}

/**
 * PATCH as Okta and Microsoft Entra send it: `replace` with a path
 * (`active`, `userName`, `name.givenName`, `emails[type eq "work"].value`…)
 * or with a value object and no path.
 */
function patched(rec, operations) {
  const next = { ...rec }
  for (const op of Array.isArray(operations) ? operations : []) {
    const kind = String(op?.op || '').toLowerCase()
    if (kind !== 'replace' && kind !== 'add') continue
    const path = String(op?.path || '')
    const value = op?.value
    if (!path && value && typeof value === 'object') {
      Object.assign(next, fromBody({ ...value, name: value.name }, next))
      if ('active' in value) next.active = asBool(value.active)
      if ('name.givenName' in value) next.givenName = textOf(value['name.givenName'])
      if ('name.familyName' in value) next.familyName = textOf(value['name.familyName'])
      continue
    }
    if (path === 'active') next.active = asBool(value)
    else if (path === 'userName') next.userName = textOf(value) || next.userName
    else if (path === 'displayName') next.displayName = textOf(value)
    else if (path === 'externalId') next.externalId = textOf(value)
    else if (path === 'name.givenName') next.givenName = textOf(value)
    else if (path === 'name.familyName') next.familyName = textOf(value)
    else if (/^emails/.test(path)) {
      const email = normalizeEmail(Array.isArray(value) ? value[0]?.value : value)
      if (email) next.email = email
    }
  }
  return next
}

/**
 * The /scim/v2/* handler. Answers SCIM JSON; the caller hands in the request
 * pieces so this file stays free of the HTTP server.
 */
export async function handleScim({ engine, db, origin, method, pathname, query, headers, body }) {
  const reply = (status, json) => ({ status, json })
  const fail = (status, detail, scimType) =>
    reply(status, { schemas: [ERROR_SCHEMA], status: String(status), detail, scimType })

  if (!(await validScimToken(db, headers.authorization))) {
    return fail(401, 'A valid SCIM token is required.')
  }
  const rest = pathname.replace(/^\/scim\/v2/, '')

  if (method === 'GET' && rest === '/ServiceProviderConfig') {
    return reply(200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 100 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'Created in WEEHS → Employees',
        },
      ],
    })
  }
  if (method === 'GET' && rest === '/ResourceTypes') {
    return reply(200, {
      schemas: [LIST_SCHEMA],
      totalResults: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: USER_SCHEMA,
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: GROUP_SCHEMA,
        },
      ],
    })
  }

  const users = async () => {
    const res = await asWorker(
      db,
      `SELECT id, data FROM documents WHERE path = 'scimUsers' ORDER BY id`,
      []
    )
    // Deleted in the directory: gone from SCIM's view, kept here as inactive.
    return res.rows
      .map((r) => ({ id: r.id, rec: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }))
      .filter(({ rec }) => !rec.deleted)
  }
  const save = async (id, rec) =>
    engine.commit(WORKER, [{ type: 'set', path: 'scimUsers', id, merge: false, data: { ...rec } }])

  if (rest === '/Users' && method === 'GET') {
    let list = await users()
    const filter = String(query.get('filter') || '')
    const m = /^(userName|externalId|emails(?:\.value)?)\s+eq\s+"([^"]*)"$/i.exec(filter.trim())
    if (filter && !m)
      return fail(
        400,
        'Only "userName eq", "externalId eq" and "emails eq" filters are supported.',
        'invalidFilter'
      )
    if (m) {
      const want = m[2].toLowerCase()
      const field = m[1].toLowerCase()
      list = list.filter(({ rec }) =>
        field === 'externalid'
          ? (rec.externalId || '').toLowerCase() === want
          : field === 'username'
            ? (rec.userName || '').toLowerCase() === want
            : rec.email === want
      )
    }
    const start = Math.max(1, Number(query.get('startIndex')) || 1)
    const count = Math.min(100, Math.max(0, Number(query.get('count') ?? 100) || 0))
    const page = list.slice(start - 1, start - 1 + count)
    return reply(200, {
      schemas: [LIST_SCHEMA],
      totalResults: list.length,
      startIndex: start,
      itemsPerPage: page.length,
      Resources: page.map(({ id, rec }) => toResource(id, rec, origin)),
    })
  }

  if (rest === '/Users' && method === 'POST') {
    const now = new Date().toISOString()
    const rec = fromBody(body, { created: now })
    if (!rec.email)
      return fail(400, 'A work email (emails or userName) is required.', 'invalidValue')
    const existing = (await users()).find(
      ({ rec: r }) =>
        r.email === rec.email || r.userName.toLowerCase() === rec.userName.toLowerCase()
    )
    if (existing) return fail(409, 'That user already exists.', 'uniqueness')
    rec.lastModified = now
    const id = randomBytes(12).toString('hex')
    await save(id, rec)
    await applyActive(engine, db, rec.email, rec.active)
    return reply(201, toResource(id, rec, origin))
  }

  const one = /^\/Users\/([A-Za-z0-9]+)$/.exec(rest)
  if (one) {
    const id = one[1]
    const found = (await users()).find((u) => u.id === id)
    if (!found) return fail(404, 'No such user.')
    if (method === 'GET') return reply(200, toResource(id, found.rec, origin))
    if (method === 'PUT' || method === 'PATCH') {
      if (method === 'PATCH' && !(body?.schemas || []).includes(PATCH_SCHEMA)) {
        return fail(400, 'A PatchOp body is required.', 'invalidSyntax')
      }
      const next =
        method === 'PUT'
          ? fromBody(body, { created: found.rec.created })
          : patched(found.rec, body?.Operations)
      if (!next.email) return fail(400, 'A work email is required.', 'invalidValue')
      next.lastModified = new Date().toISOString()
      // A changed address: the old one is no longer this person's here.
      if (next.email !== found.rec.email) await applyActive(engine, db, found.rec.email, false)
      await save(id, next)
      await applyActive(engine, db, next.email, next.active)
      return reply(200, toResource(id, next, origin))
    }
    if (method === 'DELETE') {
      // Deleted in the directory: disabled here, and remembered as inactive,
      // so joining by domain or group cannot let them back in.
      const next = {
        ...found.rec,
        active: false,
        deleted: true,
        lastModified: new Date().toISOString(),
      }
      await save(id, next)
      await applyActive(engine, db, found.rec.email, false)
      return reply(204, null)
    }
  }

  // ── Groups ──
  const groupRows = () => scimGroupRows(db)
  const knownUsers = async () => new Set((await users()).map((u) => u.id))
  const memberIds = (list, known) =>
    (Array.isArray(list) ? list : []).map((m) => String(m?.value || '')).filter((v) => known.has(v))
  const saveGroup = async (id, rec) =>
    engine.commit(WORKER, [{ type: 'set', path: 'scimGroups', id, merge: false, data: { ...rec } }])
  const groupResource = (id, rec) => ({
    schemas: [GROUP_SCHEMA],
    id,
    externalId: rec.externalId || undefined,
    displayName: rec.displayName,
    members: (rec.members || []).map((value) => ({
      value,
      $ref: `${origin}/scim/v2/Users/${value}`,
    })),
    meta: {
      resourceType: 'Group',
      created: rec.created,
      lastModified: rec.lastModified,
      location: `${origin}/scim/v2/Groups/${id}`,
    },
  })

  if (rest === '/Groups' && method === 'GET') {
    let list = await groupRows()
    const filter = String(query.get('filter') || '')
    const m = /^(displayName|externalId)\s+eq\s+"([^"]*)"$/i.exec(filter.trim())
    if (filter && !m)
      return fail(
        400,
        'Only "displayName eq" and "externalId eq" filters are supported.',
        'invalidFilter'
      )
    if (m) {
      const field = m[1].toLowerCase() === 'externalid' ? 'externalId' : 'displayName'
      list = list.filter(({ rec }) => (rec[field] || '') === m[2])
    }
    const start = Math.max(1, Number(query.get('startIndex')) || 1)
    const count = Math.min(100, Math.max(0, Number(query.get('count') ?? 100) || 0))
    const page = list.slice(start - 1, start - 1 + count)
    // Okta asks for groups without members when it only needs to find one.
    const bare = String(query.get('excludedAttributes') || '').includes('members')
    return reply(200, {
      schemas: [LIST_SCHEMA],
      totalResults: list.length,
      startIndex: start,
      itemsPerPage: page.length,
      Resources: page.map(({ id, rec }) => {
        const r = groupResource(id, rec)
        if (bare) delete r.members
        return r
      }),
    })
  }

  if (rest === '/Groups' && method === 'POST') {
    const displayName = textOf(body?.displayName)
    if (!displayName) return fail(400, 'displayName is required.', 'invalidValue')
    if ((await groupRows()).some(({ rec }) => rec.displayName === displayName)) {
      return fail(409, 'That group already exists.', 'uniqueness')
    }
    const now = new Date().toISOString()
    const rec = {
      displayName,
      externalId: textOf(body?.externalId),
      members: memberIds(body?.members, await knownUsers()),
      created: now,
      lastModified: now,
    }
    const id = randomBytes(12).toString('hex')
    await saveGroup(id, rec)
    await resyncRoles(engine, db, new Set(rec.members))
    return reply(201, groupResource(id, rec))
  }

  const oneGroup = /^\/Groups\/([A-Za-z0-9]+)$/.exec(rest)
  if (oneGroup) {
    const id = oneGroup[1]
    const found = (await groupRows()).find((g) => g.id === id)
    if (!found) return fail(404, 'No such group.')
    if (method === 'GET') return reply(200, groupResource(id, found.rec))
    if (method === 'PUT' || method === 'PATCH') {
      if (method === 'PATCH' && !(body?.schemas || []).includes(PATCH_SCHEMA)) {
        return fail(400, 'A PatchOp body is required.', 'invalidSyntax')
      }
      const known = await knownUsers()
      const next = { ...found.rec, members: [...(found.rec.members || [])] }
      if (method === 'PUT') {
        next.displayName = textOf(body?.displayName) || next.displayName
        next.externalId = textOf(body?.externalId) || next.externalId
        next.members = memberIds(body?.members, known)
      } else {
        for (const op of Array.isArray(body?.Operations) ? body.Operations : []) {
          const kind = String(op?.op || '').toLowerCase()
          const path = String(op?.path || '')
          const value = op?.value
          const filtered = /^members\[value eq "([^"]+)"\]$/.exec(path)
          if (kind === 'add' && path === 'members') {
            for (const v of memberIds(value, known))
              if (!next.members.includes(v)) next.members.push(v)
          } else if (kind === 'remove' && filtered) {
            next.members = next.members.filter((v) => v !== filtered[1])
          } else if (kind === 'remove' && path === 'members') {
            const drop = new Set(
              Array.isArray(value) ? value.map((m) => String(m?.value || '')) : []
            )
            next.members = drop.size ? next.members.filter((v) => !drop.has(v)) : []
          } else if (kind === 'replace' && path === 'members') {
            next.members = memberIds(value, known)
          } else if (kind === 'replace' && path === 'displayName') {
            next.displayName = textOf(value) || next.displayName
          } else if (kind === 'replace' && path === 'externalId') {
            next.externalId = textOf(value)
          } else if (kind === 'replace' && !path && value && typeof value === 'object') {
            if (value.displayName) next.displayName = textOf(value.displayName)
            if (value.externalId) next.externalId = textOf(value.externalId)
            if (value.members) next.members = memberIds(value.members, known)
          }
        }
      }
      next.lastModified = new Date().toISOString()
      await saveGroup(id, next)
      const touched = new Set([...(found.rec.members || []), ...next.members])
      await resyncRoles(engine, db, touched)
      return reply(200, groupResource(id, next))
    }
    if (method === 'DELETE') {
      await saveGroup(id, { ...found.rec, deleted: true, lastModified: new Date().toISOString() })
      await resyncRoles(engine, db, new Set(found.rec.members || []))
      return reply(204, null)
    }
  }
  return fail(404, 'Not found.')
}
