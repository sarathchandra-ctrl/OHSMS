// Document engine over SQLite (Cloudflare D1; Node's SQLite locally and in tests).
//
// One table, addressed as (path, id), which is what the app's data seam
// requires (src/shared/data/index.js): a QR mirror and the record it mirrors
// are written in one batch, across collections.
//
// Who may do what is stack/policy.mjs. Every read and every write op is
// checked there first, against the caller's stored profile, and refused
// before any SQL runs. `session` is { role, uid }: role 'ohsms_worker' is a
// server job and skips the policies; 'ohsms_browser' is everyone else.
//
// Writes are all-or-nothing. D1 has no interactive transactions, so commit:
//   1. reads every row it will touch (and the caller's profile, and any QR
//      mirror a public report names), with their revisions;
//   2. decides each op with the policy and computes the new documents;
//   3. sends ONE batch — a single SQLite transaction — whose first statement
//      fails the whole batch if any of those rows changed since step 1
//      (commit_guard has a NOT NULL column it inserts NULL into), followed by
//      the writes. A conflict writes nothing and is retried from step 1.
//
// Noted divergences from Firestore, on purpose (src/shared/data/index.js):
// `where('x','==',null)` matches a missing field as well as a JSON null, and
// orderBy keeps documents that lack the field (they sort last).

import {
  applyPatch,
  assertField,
  encodeTree,
  nextTimestamp,
  revive,
} from '../src/shared/data/adapters/postgresWire.js'
import { ensureSchema } from './schema.mjs'
import {
  canRead,
  deleteAllowed,
  insertAllowed,
  invariantProblem,
  queryProblem,
  reachOf,
  readScope,
  serverStampedInsert,
  siteBlocked,
  siteScoped,
  updateAllowed,
  visibleRow,
} from './policy.mjs'

const ROLES = new Set(['ohsms_browser', 'ohsms_worker'])
// D1 allows 100 bound parameters per statement.
const KEYS_PER_READ = 45
const KEYS_PER_GUARD = 30
const ROWS_PER_UPSERT = 24
const KEYS_PER_DELETE = 45
const ATTEMPTS = 5
// D1 stores at most 2,000,000 bytes in one row. A larger record used to reach
// D1, fail there, and come back as a 500 "request failed" with nothing to say
// why; the request limit (4 MB, stack/handler.mjs) is twice the row limit, so
// one record carrying a few inline attachments could get that far. The record
// is refused here instead, before any statement runs, with the reason. The
// margin leaves room for the row's path, id and rev. Counted in UTF-8 bytes,
// not characters: D1's limit is bytes, and text in most of the world's
// scripts is two to four bytes a character.
export const MAX_RECORD_BYTES = 1_900_000
const utf8 = new TextEncoder()

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

export async function applySchema(db) {
  await ensureSchema(db)
}

function parse(text) {
  if (text === null || text === undefined) return undefined
  return typeof text === 'string' ? JSON.parse(text) : text
}

function rowToDoc(row, { rev = false, path, ctx } = {}) {
  if (!row) return null
  // What this caller is shown of the row (policy.visibleRow narrows profiles).
  const stored = parse(row.data)
  const data = revive(ctx && path ? visibleRow(path, row.id, stored, ctx) : stored)
  const doc = { id: row.id, ...data }
  if (rev) return { rev: row.rev, data: doc }
  return doc
}

// ── Queries ─────────────────────────────────────────────────────────────────

/** A SQLite JSON path for a dotted field. Field names are [A-Za-z0-9_] only. */
function jsonPath(field, extra = []) {
  return '$' + [...assertField(field), ...extra].map((s) => `."${s}"`).join('')
}

function equalsSql(p, value, params) {
  const v = encodeTree(value)
  if (v === null || v === undefined) {
    return `(json_type(data, '${p}') IS NULL OR json_type(data, '${p}') = 'null')`
  }
  if (typeof v === 'boolean') {
    params.push(v ? 'true' : 'false')
    return `json_type(data, '${p}') = ?`
  }
  if (typeof v === 'number') {
    params.push(v)
    return `(json_type(data, '${p}') IN ('integer', 'real') AND json_extract(data, '${p}') = ?)`
  }
  if (typeof v === 'string') {
    params.push(v)
    return `(json_type(data, '${p}') = 'text' AND json_extract(data, '${p}') = ?)`
  }
  params.push(JSON.stringify(v))
  return `(json_type(data, '${p}') IN ('object', 'array') AND json(json_extract(data, '${p}')) = json(?))`
}

function whereSql(opts, params) {
  const parts = []
  for (const c of opts.where || []) {
    const p = jsonPath(c.field)
    if (c.op === '==') {
      parts.push(equalsSql(p, c.value, params))
      continue
    }
    if (c.op === 'in') {
      const list = Array.isArray(c.value) ? c.value : []
      parts.push(list.length ? `(${list.map((v) => equalsSql(p, v, params)).join(' OR ')})` : '0')
      continue
    }
    if (c.op === '!=') {
      parts.push(`(json_type(data, '${p}') IS NOT NULL AND NOT ${equalsSql(p, c.value, params)})`)
      continue
    }
    const op = { '<': '<', '<=': '<=', '>': '>', '>=': '>=' }[c.op]
    if (!op) throw fail('invalid-argument', `sqlite: unsupported where op '${c.op}'`)
    const bound = encodeTree(c.value)
    if (bound && bound.__ohsms === 'ts') {
      params.push(bound.s * 1e9 + (bound.ns || 0))
      const kind = jsonPath(c.field, ['__ohsms'])
      const s = jsonPath(c.field, ['s'])
      const ns = jsonPath(c.field, ['ns'])
      parts.push(
        `(CASE WHEN json_extract(data, '${kind}') = 'ts' THEN json_extract(data, '${s}') * 1000000000 + COALESCE(json_extract(data, '${ns}'), 0) END) ${op} ?`
      )
      continue
    }
    if (typeof bound === 'number') {
      params.push(bound)
      parts.push(
        `(CASE WHEN json_type(data, '${p}') IN ('integer', 'real') THEN json_extract(data, '${p}') END) ${op} ?`
      )
      continue
    }
    if (typeof bound === 'string') {
      params.push(bound)
      parts.push(
        `(CASE WHEN json_type(data, '${p}') = 'text' THEN json_extract(data, '${p}') END) ${op} ?`
      )
      continue
    }
    throw fail('invalid-argument', `sqlite: cannot compare ${c.op} against ${typeof c.value}`)
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : ''
}

function orderSql(opts) {
  if (!opts.orderBy) return ' ORDER BY id ASC'
  const p = jsonPath(opts.orderBy[0])
  const kind = jsonPath(opts.orderBy[0], ['__ohsms'])
  const s = jsonPath(opts.orderBy[0], ['s'])
  const ns = jsonPath(opts.orderBy[0], ['ns'])
  const dir = opts.orderBy[1] === 'desc' ? 'DESC' : 'ASC'
  // The leading key is always ASC, so a missing field sorts last both ways.
  return ` ORDER BY
    CASE WHEN json_type(data, '${p}') IS NULL OR json_type(data, '${p}') = 'null' THEN 1 ELSE 0 END ASC,
    CASE WHEN json_type(data, '${p}') IN ('integer', 'real') THEN json_extract(data, '${p}') END ${dir},
    CASE WHEN json_type(data, '${p}') = 'text' THEN json_extract(data, '${p}') END ${dir},
    CASE WHEN json_extract(data, '${kind}') = 'ts' THEN json_extract(data, '${s}') END ${dir},
    CASE WHEN json_extract(data, '${kind}') = 'ts' THEN json_extract(data, '${ns}') END ${dir},
    id ASC`
}

/**
 * The site half of a read: rows that name a site the caller does not reach
 * are left out (policy.siteBlocked). The reach goes in as ONE JSON parameter,
 * because Cloudflare D1 caps a statement at 100 bound values and an
 * organization can have more sites than that.
 */
function siteSql(path, ctx, params) {
  if (ctx.worker || !ctx.reach || !siteScoped(path)) return ''
  params.push(JSON.stringify([...ctx.reach]))
  const visibleToAll =
    path === 'documents' ? " OR json_extract(data, '$.visibility') = 'all'" : ''
  return (
    " AND (json_extract(data, '$.siteId') IS NULL OR json_extract(data, '$.siteId') = ''" +
    " OR json_extract(data, '$.siteId') IN (SELECT value FROM json_each(?))" +
    visibleToAll +
    ')'
  )
}

/** The SQL that limits a read to what readScope allows, or null for nothing. */
function scopeSql(path, ctx, params) {
  const scope = readScope(path, ctx)
  if (scope === 'none') return null
  // Read by id only (the public QR mirrors): a get is answered, a list or a
  // count is not.
  if (scope === 'get-only') return null
  let sql = ''
  if (scope === 'all-but-crypto') sql = " AND id != 'cryptoKeys'"
  else if (scope !== 'all' && scope.ownedBy) {
    // The same two fields policy.ownedBy reads, so a list and a get agree.
    params.push(scope.ownedBy, scope.ownedBy)
    sql = " AND (json_extract(data, '$.createdBy') = ? OR json_extract(data, '$.createdByUid') = ?)"
  } else if (scope !== 'all') {
    params.push(scope.onlyId)
    sql = ' AND id = ?'
  }
  return sql + siteSql(path, ctx, params)
}

const keyOf = (path, id) => `${path}\u0000${id}`

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * @param {object} db  Cloudflare D1, or stack/sqlite.mjs
 */
export function createEngine(db) {
  function checkRole(session) {
    if (session?.role && !ROLES.has(session.role))
      throw fail('invalid-argument', 'sqlite: unknown role')
  }

  const isWorker = (session) => session?.role === 'ohsms_worker' || !session?.role

  async function readRows(keys) {
    const found = new Map()
    for (const part of chunks(keys, KEYS_PER_READ)) {
      const params = []
      const values = part.map(([path, id]) => {
        params.push(path, id)
        return '(?, ?)'
      })
      const res = await db
        .prepare(
          `SELECT path, id, rev, data FROM documents WHERE (path, id) IN (VALUES ${values.join(', ')})`
        )
        .bind(...params)
        .all()
      for (const row of res.results || []) found.set(keyOf(row.path, row.id), row)
    }
    return found
  }

  async function contextFor(session, rows) {
    const uid = session?.uid || ''
    const worker = isWorker(session)
    let profileRow = null
    if (!worker && uid) {
      profileRow = rows?.get(keyOf('users', uid))
      if (profileRow === undefined) {
        profileRow =
          (await db
            .prepare("SELECT path, id, rev, data FROM documents WHERE path = 'users' AND id = ?")
            .bind(uid)
            .first()) || null
      }
    }
    const profile = profileRow ? parse(profileRow.data) : null
    // The sites this caller reaches (policy.reachOf). Admins, server jobs and
    // signed-out callers are not site-scoped; for everyone else this is one
    // read of the site register per request.
    let reach = null
    if (!worker && profile && profile.role !== 'admin') {
      const res = await db
        .prepare("SELECT id, data FROM documents WHERE path = 'sites'")
        .all()
      reach = reachOf(
        profile,
        (res.results || []).map((r) => ({ id: r.id, ...parse(r.data) }))
      )
    }
    return { ctx: { uid, worker, profile, reach }, profileRow }
  }

  /**
   * Records inside a record (an incident's photos, a permit's documents) carry
   * no site of their own; they are as visible as the record they belong to.
   * Returns [parentPath, parentId] for a sub-collection path, else null.
   */
  const parentOf = (path) => {
    const parts = String(path).split('/')
    return parts.length >= 3 ? [parts[0], parts[1]] : null
  }

  async function parentBlocked(path, ctx, rows) {
    const parent = parentOf(path)
    if (!parent || ctx.worker || !ctx.reach) return false
    let row = rows?.get(keyOf(parent[0], parent[1]))
    if (row === undefined) {
      row = await db
        .prepare('SELECT data FROM documents WHERE path = ? AND id = ?')
        .bind(parent[0], parent[1])
        .first()
    }
    return Boolean(row) && siteBlocked(parent[0], parse(row.data), ctx)
  }

  async function commitOnce(session, ops, expect) {
    const uid = session?.uid || ''
    const keys = new Map()
    const want = (path, id) => keys.set(keyOf(path, id), [path, id])
    for (const op of ops) want(op.path, op.id)
    for (const seen of expect) want(seen.path, seen.id)
    if (!isWorker(session) && uid) want('users', uid)
    // A public report is bound to the QR mirror its token names.
    for (const op of ops) {
      const token = op.data?.token
      if (typeof token === 'string' && token) {
        if (op.path === 'reports' || op.path === 'defectLocks') want('qr', token)
        if (op.path === 'observations') want('permitQr', token)
      }
      // An employee's own training record is judged against its course.
      if (op.path === 'trainingRecords' && typeof op.data?.courseId === 'string' && op.data.courseId) {
        want('trainingCourses', op.data.courseId)
      }
      // A new LOTO permit's window is judged against the site's shift clocks.
      if (op.path === 'lotoPermits') want('lotoSettings', 'shifts')
      const parent = parentOf(op.path)
      if (parent) want(parent[0], parent[1])
    }
    const rows = await readRows([...keys.values()])
    // A permit's public QR record is judged against the permit it names
    // (permitMirrorProblem). A merge update does not carry permitId, so it is
    // read from the stored record, and the permit is loaded and guarded too.
    const permitKeys = []
    for (const op of ops) {
      if (op.path !== 'permitQr') continue
      const stored = rows.get(keyOf('permitQr', op.id))
      const permitId = String(op.data?.permitId || (stored && parse(stored.data)?.permitId) || '')
      if (permitId && !keys.has(keyOf('permits', permitId))) {
        want('permits', permitId)
        permitKeys.push(['permits', permitId])
      }
    }
    if (permitKeys.length) for (const [k, row] of await readRows(permitKeys)) rows.set(k, row)
    const { ctx } = await contextFor(session, rows)

    for (const seen of expect) {
      const row = rows.get(keyOf(seen.path, seen.id))
      if ((row ? row.rev : 0) !== seen.rev) return { stale: true, paths: [] }
    }

    // Working state: later ops in the batch see earlier ones, as they did in
    // one Postgres transaction.
    const state = new Map()
    for (const [k, row] of rows) state.set(k, { rev: row.rev, data: parse(row.data) })
    const lookup = (path, id) => state.get(keyOf(path, id))?.data
    const touched = new Map() // key -> [path, id]

    for (const op of ops) {
      const k = keyOf(op.path, op.id)
      const current = state.get(k)
      // Inside a record of a site the writer does not reach (as the batch has
      // it so far, so a record and its photo created together are judged
      // together).
      const parent = parentOf(op.path)
      const parentRow = parent ? state.get(keyOf(parent[0], parent[1])) : null
      if (!ctx.worker && parentRow && siteBlocked(parent[0], parentRow.data, ctx)) {
        throw fail('permission-denied', `sqlite: write refused at ${op.path}/${op.id} (site)`)
      }
      if (op.type === 'remove') {
        if (!current) continue
        // Not visible to this caller: nothing they could remove.
        if (!ctx.worker && !canRead(op.path, op.id, ctx, current.data)) continue
        const why = deleteAllowed(op.path, op.id, current.data, ctx)
        if (why)
          throw fail('permission-denied', `sqlite: delete refused at ${op.path}/${op.id} (${why})`)
        state.delete(k)
        touched.set(k, [op.path, op.id])
        continue
      }
      if (op.type === 'createExclusive') {
        if (current) throw fail('already-exists', `sqlite: ${op.path}/${op.id} already exists`)
        const data = serverStampedInsert(op.path, applyPatch(undefined, op), ctx, () => nextTimestamp())
        const why =
          insertAllowed(op.path, op.id, data, ctx, lookup) ||
          invariantProblem(op.path, op.id, undefined, data, ctx, lookup)
        if (why)
          throw fail('permission-denied', `sqlite: create refused at ${op.path}/${op.id} (${why})`)
        state.set(k, { rev: 1, data })
        touched.set(k, [op.path, op.id])
        continue
      }
      const visible = current && (ctx.worker || canRead(op.path, op.id, ctx, current.data))
      if (op.type === 'update' && !visible) {
        throw fail('not-found', `sqlite: no document to update at ${op.path}/${op.id}`)
      }
      if (current && !visible) {
        // A set over a row the caller cannot see: refused, never overwritten.
        throw fail('permission-denied', `sqlite: write refused at ${op.path}/${op.id}`)
      }
      const patched = applyPatch(current?.data, op, () => nextTimestamp())
      const data = current ? patched : serverStampedInsert(op.path, patched, ctx, () => nextTimestamp())
      const why = current
        ? updateAllowed(op.path, op.id, current.data, data, ctx) ||
          invariantProblem(op.path, op.id, current.data, data, ctx, lookup)
        : insertAllowed(op.path, op.id, data, ctx, lookup) ||
          invariantProblem(op.path, op.id, undefined, data, ctx, lookup)
      if (why)
        throw fail('permission-denied', `sqlite: write refused at ${op.path}/${op.id} (${why})`)
      state.set(k, { rev: (current?.rev || 0) + 1, data })
      touched.set(k, [op.path, op.id])
    }

    if (!touched.size) return { stale: false, paths: [] }

    // Guards: every row read in step 1 must still be exactly as read.
    const statements = []
    for (const part of chunks([...keys.values()], KEYS_PER_GUARD)) {
      const params = []
      const values = part.map(([path, id]) => {
        const row = rows.get(keyOf(path, id))
        params.push(path, id, row ? row.rev : 0)
        return '(?, ?, ?)'
      })
      statements.push(
        db
          .prepare(
            `WITH v(p, i, r) AS (VALUES ${values.join(', ')})
             INSERT INTO commit_guard (ok) SELECT NULL WHERE EXISTS (
               SELECT 1 FROM v LEFT JOIN documents d ON d.path = v.p AND d.id = v.i
               WHERE COALESCE(d.rev, 0) != v.r)`
          )
          .bind(...params)
      )
    }
    const upserts = []
    const deletes = []
    // What each touched row was and became, for the notifications that follow
    // a commit (stack/notify.mjs). Server-side only: handler.mjs strips it
    // before the response, which carries the paths alone.
    const changes = []
    for (const [k, [path, id]] of touched) {
      const next = state.get(k)
      changes.push({ path, id, before: rows.has(k) ? parse(rows.get(k).data) : null, after: next ? next.data : null })
      if (next) {
        const data = JSON.stringify(encodeTree(next.data))
        const bytes = utf8.encode(data).byteLength
        if (bytes > MAX_RECORD_BYTES) {
          throw fail(
            'invalid-argument',
            `sqlite: record too large at ${path}/${id} (${bytes} bytes; the limit is ${MAX_RECORD_BYTES})`
          )
        }
        upserts.push([path, id, next.rev, data])
      } else if (rows.has(k)) deletes.push([path, id])
    }
    for (const part of chunks(upserts, ROWS_PER_UPSERT)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO documents (path, id, rev, data) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}
             ON CONFLICT (path, id) DO UPDATE SET rev = excluded.rev, data = excluded.data`
          )
          .bind(...part.flat())
      )
    }
    for (const part of chunks(deletes, KEYS_PER_DELETE)) {
      statements.push(
        db
          .prepare(
            `DELETE FROM documents WHERE (path, id) IN (VALUES ${part.map(() => '(?, ?)').join(', ')})`
          )
          .bind(...part.flat())
      )
    }
    try {
      await db.batch(statements)
    } catch (e) {
      if (/commit_guard/.test(String(e?.message))) return { conflict: true }
      throw e
    }
    return { stale: false, paths: [...new Set(ops.map((op) => op.path))], changes }
  }

  return {
    db,

    async get(session, path, id, opts) {
      checkRole(session)
      const { ctx } = await contextFor(session)
      if (!ctx.worker && readScope(path, ctx) === 'none') return null
      if (await parentBlocked(path, ctx)) return null
      const row = await db
        .prepare('SELECT id, rev, data FROM documents WHERE path = ? AND id = ?')
        .bind(path, id)
        .first()
      if (!ctx.worker && row && !canRead(path, id, ctx, parse(row.data))) return null
      return rowToDoc(row, { ...opts, path, ctx })
    },

    async list(session, path, opts = {}) {
      checkRole(session)
      const { ctx } = await contextFor(session)
      const hidden = queryProblem(path, opts, ctx)
      if (hidden) throw fail('permission-denied', `sqlite: query refused at ${path} (${hidden})`)
      if (await parentBlocked(path, ctx)) return []
      const params = [path]
      const scope = ctx.worker ? '' : scopeSql(path, ctx, params)
      if (scope === null) return []
      const where = whereSql(opts, params)
      let sql = `SELECT id, rev, data FROM documents WHERE path = ?${scope}${where}${orderSql(opts)}`
      if (opts.limit) {
        params.push(Number(opts.limit))
        sql += ' LIMIT ?'
      }
      const res = await db
        .prepare(sql)
        .bind(...params)
        .all()
      return (res.results || []).map((row) => rowToDoc(row, { path, ctx }))
    },

    async count(session, path, opts = {}) {
      checkRole(session)
      const { ctx } = await contextFor(session)
      const hidden = queryProblem(path, opts, ctx)
      if (hidden) throw fail('permission-denied', `sqlite: query refused at ${path} (${hidden})`)
      if (await parentBlocked(path, ctx)) return 0
      const params = [path]
      const scope = ctx.worker ? '' : scopeSql(path, ctx, params)
      if (scope === null) return 0
      const where = whereSql(opts, params)
      let sql = `SELECT count(*) AS n FROM documents WHERE path = ?${scope}${where}`
      if (opts.limit) {
        params.push(Number(opts.limit))
        sql = `SELECT count(*) AS n FROM (SELECT 1 FROM documents WHERE path = ?${scope}${where} LIMIT ?)`
      }
      const row = await db
        .prepare(sql)
        .bind(...params)
        .first()
      return Number(row?.n ?? 0)
    },

    /**
     * All-or-nothing. `expect` is the rev each transactional read observed; a
     * mismatch writes nothing and returns `{ stale: true }` so the body runs
     * again. Without `expect`, a concurrent change is retried here.
     */
    async commit(session, ops, expect = []) {
      checkRole(session)
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const result = await commitOnce(session, ops || [], expect || [])
        if (!result.conflict) return result
        if (expect.length) return { stale: true, paths: [] }
      }
      throw fail('aborted', 'sqlite: the records kept changing; try again')
    },

    async truncate() {
      await db.batch(
        ['documents', 'auth_secrets', 'auth_pending', 'auth_totp'].map((t) => db.prepare(`DELETE FROM ${t}`))
      )
    },
  }
}
