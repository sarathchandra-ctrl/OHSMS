// Document engine for the postgres adapter.
//
// One table, addressed as (path, id), which is what the seam requires: a QR
// mirror and the org document it mirrors are one transaction, and a path
// helper that could only say organizations/… could not carry that write.
// Tenancy is RLS (stack/schema.sql), applied by SET LOCAL ROLE inside the
// same transaction as the statement. This file does not decide who may write.
//
// Noted divergence from Firestore, on purpose (src/shared/data/index.js):
// `where('x','==',null)` matches a missing field as well as a JSON null.
// Firestore does not. orderBy keeps documents that lack the field.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyPatch,
  encodeTree,
  jsonbPath,
  nextTimestamp,
  revive,
} from '../src/shared/data/adapters/postgresWire.js'

// Read on first use, not at import: the Cloudflare Worker has no file system
// and passes the schema text it was bundled with instead.
let schemaText = null
function defaultSchema() {
  schemaText ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')
  return schemaText
}

const ROLES = new Set(['ohsms_browser', 'ohsms_worker'])

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function mapError(e) {
  if (e?.code === '42501' || e?.code === 'permission-denied') {
    return fail('permission-denied', e.message || 'permission denied')
  }
  if (e?.code === '23505' || e?.code === 'already-exists') {
    return fail('already-exists', e.message || 'already exists')
  }
  if (e?.code === 'not-found' || e?.code === 'invalid-argument' || e?.code === 'aborted') return e
  return e
}

/**
 * Run `sql` as the worker role. invites and auth_secrets FORCE row level
 * security, so a statement issued as the login role is refused on any
 * Postgres where that role is not a superuser — which is every managed one.
 * On PGlite the login role is a superuser and bypasses RLS anyway, which is
 * how fulfillment, first sign-in and the password gate shipped working only
 * there. The role is set for this statement's transaction and no longer.
 */
export async function asWorker(db, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE ohsms_worker')
    return tx.query(sql, params)
  })
}

export async function applySchema(db, sql = defaultSchema()) {
  await db.exec(sql)
}

function rowToDoc(row, { rev = false } = {}) {
  if (!row) return null
  const data = revive(row.data)
  const doc = { id: row.id, ...data }
  if (rev) return { rev: row.rev, data: doc }
  return doc
}

function dirOf(orderBy) {
  const dir = orderBy?.[1] === 'desc' ? 'DESC' : 'ASC'
  return dir
}

function whereSql(opts, params) {
  const parts = []
  for (const c of opts.where || []) {
    const path = jsonbPath(c.field)
    const expr = `data #> '${path}'`
    if (c.op === '==' && c.value === null) {
      // SQL null and a missing key are the same answer here. Firestore's
      // `== null` does not match a missing field; that difference is the
      // adapter note, not something this query pretends away.
      parts.push(`(jsonb_typeof(${expr}) IS NULL OR jsonb_typeof(${expr}) = 'null')`)
      continue
    }
    if (c.op === '==') {
      params.push(JSON.stringify(encodeTree(c.value)))
      parts.push(`${expr} = $${params.length}::jsonb`)
      continue
    }
    if (c.op === 'in') {
      params.push(JSON.stringify((c.value || []).map((v) => encodeTree(v))))
      parts.push(`${expr} IN (SELECT jsonb_array_elements($${params.length}::jsonb))`)
      continue
    }
    if (c.op === '!=') {
      params.push(JSON.stringify(encodeTree(c.value)))
      parts.push(
        `(jsonb_typeof(${expr}) IS NOT NULL AND ${expr} IS DISTINCT FROM $${params.length}::jsonb)`
      )
      continue
    }
    const bound = encodeTree(c.value)
    const op = { '<': '<', '<=': '<=', '>': '>', '>=': '>=' }[c.op]
    if (bound && bound.__ohsms === 'ts') {
      params.push(bound.s * 1e9 + (bound.ns || 0))
      parts.push(`(
        CASE WHEN ${expr}->>'__ohsms' = 'ts'
          THEN (${expr}->>'s')::numeric * 1000000000 + COALESCE((${expr}->>'ns')::numeric, 0)
          ELSE NULL END
      ) ${op} $${params.length}`)
      continue
    }
    if (typeof bound === 'number') {
      params.push(bound)
      parts.push(
        `(CASE WHEN jsonb_typeof(${expr}) = 'number' THEN (${expr} #>> '{}')::numeric ELSE NULL END) ${op} $${params.length}`
      )
      continue
    }
    if (typeof bound === 'string') {
      params.push(bound)
      parts.push(
        `(CASE WHEN jsonb_typeof(${expr}) = 'string' THEN ${expr} #>> '{}' ELSE NULL END) ${op} $${params.length}`
      )
      continue
    }
    throw fail('invalid-argument', `postgres: cannot compare ${c.op} against ${typeof c.value}`)
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : ''
}

function orderSql(opts) {
  if (!opts.orderBy) return ' ORDER BY id ASC'
  const path = jsonbPath(opts.orderBy[0])
  const expr = `data #> '${path}'`
  const dir = dirOf(opts.orderBy)
  // The leading key is always ASC so a missing field sorts last in both
  // directions. DESC NULLS FIRST would put the gap at the head of a capped list.
  return ` ORDER BY
    CASE WHEN jsonb_typeof(${expr}) IS NULL OR jsonb_typeof(${expr}) = 'null' THEN 1 ELSE 0 END ASC,
    CASE WHEN jsonb_typeof(${expr}) = 'number' THEN (${expr} #>> '{}')::numeric END ${dir},
    CASE WHEN jsonb_typeof(${expr}) = 'string' THEN ${expr} #>> '{}' END ${dir},
    CASE WHEN ${expr}->>'__ohsms' = 'ts' THEN (${expr}->>'s')::numeric END ${dir},
    CASE WHEN ${expr}->>'__ohsms' = 'ts' THEN (${expr}->>'ns')::numeric END ${dir},
    id ASC`
}

/**
 * @param {{ query: Function, transaction: Function, exec: Function }} db
 */
export function createEngine(db) {
  async function scoped(session, fn) {
    try {
      return await db.transaction(async (tx) => {
        if (session?.role) {
          if (!ROLES.has(session.role)) throw fail('invalid-argument', 'postgres: unknown role')
          await tx.exec(`SET LOCAL ROLE ${session.role}`)
          await tx.query(`SELECT set_config('app.uid', $1, true)`, [session.uid || ''])
        }
        return await fn(tx)
      })
    } catch (e) {
      throw mapError(e)
    }
  }

  async function readRow(tx, path, id) {
    const res = await tx.query('SELECT id, rev, data FROM documents WHERE path = $1 AND id = $2', [
      path,
      id,
    ])
    return res.rows[0] || null
  }

  async function applyOne(tx, op) {
    if (op.type === 'remove') {
      // A row the caller can read but not delete comes back as zero rows, not
      // an error: DELETE policies filter, they do not raise. That would let an
      // auditor's client believe the incident was gone. If we could see it and
      // it is still there, the delete was refused.
      const existing = await readRow(tx, op.path, op.id)
      const res = await tx.query('DELETE FROM documents WHERE path = $1 AND id = $2', [
        op.path,
        op.id,
      ])
      if (existing && !res.affectedRows) {
        throw fail('permission-denied', `postgres: delete refused at ${op.path}/${op.id}`)
      }
      return
    }
    if (op.type === 'createExclusive') {
      // Primary-key violation, not SELECT then INSERT, and not ON CONFLICT:
      // ON CONFLICT asks to see the row, so a token-bound insert the caller
      // is not allowed to read back fails the policy even when the INSERT
      // check would have passed. The contract allows the unique violation.
      const data = applyPatch(undefined, op)
      try {
        await tx.query(
          'INSERT INTO documents (path, id, rev, data) VALUES ($1, $2, 1, $3::jsonb)',
          [op.path, op.id, JSON.stringify(data)]
        )
      } catch (e) {
        if (e?.code === '23505')
          throw fail('already-exists', `postgres: ${op.path}/${op.id} already exists`)
        throw e
      }
      return
    }
    const existing = await readRow(tx, op.path, op.id)
    if (op.type === 'update' && !existing) {
      throw fail('not-found', `postgres: no document to update at ${op.path}/${op.id}`)
    }
    const prev = existing ? existing.data : undefined
    const data = applyPatch(prev, op, () => nextTimestamp())
    if (!existing) {
      await tx.query('INSERT INTO documents (path, id, rev, data) VALUES ($1, $2, 1, $3::jsonb)', [
        op.path,
        op.id,
        JSON.stringify(data),
      ])
      return
    }
    const res = await tx.query(
      'UPDATE documents SET data = $3::jsonb, rev = rev + 1 WHERE path = $1 AND id = $2',
      [op.path, op.id, JSON.stringify(data)]
    )
    if (!res.affectedRows)
      throw fail('not-found', `postgres: no document to update at ${op.path}/${op.id}`)
  }

  return {
    async get(session, path, id, opts) {
      return scoped(session, async (tx) => {
        const row = await readRow(tx, path, id)
        return rowToDoc(row, opts)
      })
    },

    async list(session, path, opts = {}) {
      return scoped(session, async (tx) => {
        const params = [path]
        const where = whereSql(opts, params)
        let sql = `SELECT id, rev, data FROM documents WHERE path = $1${where}${orderSql(opts)}`
        if (opts.limit) {
          params.push(Number(opts.limit))
          sql += ` LIMIT $${params.length}`
        }
        const res = await tx.query(sql, params)
        return res.rows.map((row) => rowToDoc(row))
      })
    },

    async count(session, path, opts = {}) {
      return scoped(session, async (tx) => {
        const params = [path]
        const where = whereSql(opts, params)
        let sql = `SELECT count(*)::int AS n FROM documents WHERE path = $1${where}`
        if (opts.limit) {
          params.push(Number(opts.limit))
          sql = `SELECT count(*)::int AS n FROM (SELECT 1 FROM documents WHERE path = $1${where}${orderSql(opts)} LIMIT $${params.length}) s`
        }
        const res = await tx.query(sql, params)
        return Number(res.rows[0]?.n ?? 0)
      })
    },

    /**
     * All-or-nothing. `expect` is the rev each transactional read observed.
     * A mismatch writes nothing and returns `{ stale: true }` so the body can
     * run again. createExclusive is INSERT … ON CONFLICT DO NOTHING, not a
     * select followed by an insert.
     */
    async commit(session, ops, expect = []) {
      return scoped(session, async (tx) => {
        for (const seen of expect) {
          const row = await readRow(tx, seen.path, seen.id)
          const rev = row ? row.rev : 0
          if (rev !== seen.rev) return { stale: true, paths: [] }
        }
        for (const op of ops) await applyOne(tx, op)
        return { stale: false, paths: [...new Set(ops.map((op) => op.path))] }
      })
    },

    async truncate() {
      await db.exec('TRUNCATE documents, files, policy_union, auth_secrets, invites')
    },
  }
}
