// ─────────────────────────────────────────────────────────────────────────────
// Postgres adapter — the generic own-database driver (docs/CUSTOM-STACK.md).
//
// The browser never receives a database URL or a password. Writes go to the
// gateway named by VITE_DATA_GATEWAY (a URL only). The gateway runs the SQL
// in stack/engine.mjs as the browser role, and RLS is the enforcement. This
// file is the seam: sentinels, batches, transactions, the synchronous
// unsubscribe. It is not a second copy of the role helpers.
//
// Where it deliberately differs from Firestore, same note as the contract:
//   where('x','==',null) matches a missing field. Firestore does not.
//   orderBy keeps documents that lack the ordered field (sorted last).
// Timestamps are revived with .seconds / .toDate() / .toMillis(). They are
// not ISO strings.
// ─────────────────────────────────────────────────────────────────────────────
import { currentAccessToken, noteSessionEnded } from '../../auth/ownStackSession'
import {
  arrayUnion,
  assertOpts,
  assertWritable,
  collectionPath,
  deleteField,
  documentId,
  encodeTree,
  increment,
  revive,
  serverTimestamp,
} from './postgresWire'
import { runtimeEnv } from '../../runtimeConfig'

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomId() {
  const bytes = new Uint8Array(20)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('')
}

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function buildAdapter(io) {
  const listeners = new Set()
  const dirty = new Set()
  let flushQueued = false
  let refuseMatch = null
  let pending = 0
  const waiters = []

  const refused = (path) => Boolean(refuseMatch) && refuseMatch(path)
  const guard = (path) => {
    if (refused(path)) throw fail('permission-denied', `postgres: '${path}' is refused`)
  }

  function track(p) {
    pending += 1
    const job = Promise.resolve(p)
    job.finally(() => {
      pending -= 1
      if (pending === 0) {
        const w = waiters.splice(0, waiters.length)
        w.forEach((fn) => fn())
      }
    })
    return job
  }

  function whenIdle() {
    if (pending === 0) return Promise.resolve()
    return new Promise((resolve) => waiters.push(resolve))
  }

  function scheduleFlush() {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      flushQueued = false
      const batch = [...dirty]
      dirty.clear()
      for (const l of batch) track(emit(l))
    })
  }

  function wake(paths) {
    const set = paths instanceof Set ? paths : new Set(paths || [])
    for (const l of listeners) {
      if (!set.size || set.has(l.path)) dirty.add(l)
    }
    scheduleFlush()
  }

  // A slow response must not start another read on every poll tick. Keep at
  // most one in flight and coalesce changes into one fresh read afterwards.
  async function emit(l) {
    if (l.closed) return
    if (l.running) {
      l.again = true
      return
    }
    l.running = true
    try {
      await emitSnapshot(l)
    } finally {
      l.running = false
      if (l.again && !l.closed) {
        l.again = false
        dirty.add(l)
        scheduleFlush()
      }
    }
  }

  async function emitSnapshot(l) {
    if (l.closed) return
    if (refused(l.path)) {
      l.closed = true
      listeners.delete(l)
      l.onError?.(fail('permission-denied', `postgres: '${l.path}' is refused`))
      return
    }
    let value
    try {
      value = l.id ? await io.get(l.path, l.id) : await io.list(l.path, l.opts)
    } catch (e) {
      if (l.closed) return
      if (l.onError) l.onError(e)
      else {
        // eslint-disable-next-line no-console
        console.error('[postgres] subscriber failed:', e?.message || e)
      }
      return
    }
    if (l.closed) return
    try {
      l.cb(value)
    } catch (e) {
      // One subscriber throwing must not reject the flush, and must not be
      // swallowed: the same call cctv and orgData already make.
      // eslint-disable-next-line no-console
      console.error('[postgres] subscriber threw while handling a change:', e?.message || e)
    }
  }

  function listen(path, id, opts, cb, onError) {
    const l = { path, id, opts: opts || {}, cb, onError, closed: false }
    listeners.add(l)
    dirty.add(l)
    scheduleFlush()
    // The gateway has the rows. A second browser only hears about them if we
    // ask again. Two seconds is the cross-client delay; the writer still sees
    // its own commit immediately, because that path wakes the listener.
    const timer = io.poll
      ? setInterval(() => {
          if (!l.closed) {
            dirty.add(l)
            scheduleFlush()
          }
        }, 2000)
      : null
    return () => {
      if (timer) clearInterval(timer)
      l.closed = true
      listeners.delete(l)
      dirty.delete(l)
    }
  }

  function op(type, path, id, data, opts) {
    const p = collectionPath(path)
    guard(p)
    const docId = documentId(id)
    if (type !== 'remove') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw fail('invalid-argument', `postgres: ${type} needs an object`)
      }
      assertWritable(data)
    }
    return { type, path: p, id: docId, data, merge: Boolean(opts?.merge) }
  }

  async function write(ops) {
    for (const one of ops) guard(one.path)
    const result = await io.commit(ops)
    if (!result?.stale) wake(result?.paths || ops.map((one) => one.path))
    return result
  }

  return {
    name: 'postgres',
    serverTimestamp,
    increment,
    arrayUnion,
    deleteField,

    async get(path, id) {
      const p = collectionPath(path)
      guard(p)
      return io.get(p, documentId(id))
    },

    async list(path, opts) {
      const p = collectionPath(path)
      guard(p)
      assertOpts(opts)
      return io.list(p, opts || {})
    },

    async count(path, opts) {
      const p = collectionPath(path)
      guard(p)
      assertOpts(opts)
      return io.count(p, opts || {})
    },

    subscribe(path, opts, cb, onError) {
      const p = collectionPath(path)
      assertOpts(opts)
      return listen(p, null, opts || {}, cb, onError)
    },

    subscribeDoc(path, id, cb, onError) {
      const p = collectionPath(path)
      return listen(p, documentId(id), {}, cb, onError)
    },

    newId(path) {
      collectionPath(path)
      return randomId()
    },

    async create(path, data) {
      const id = this.newId(path)
      await write([op('createExclusive', path, id, data)])
      return id
    },

    async set(path, id, data, opts) {
      await write([op('set', path, id, data, opts)])
    },

    async createExclusive(path, id, data) {
      await write([op('createExclusive', path, id, data)])
    },

    async update(path, id, data) {
      await write([op('update', path, id, data)])
    },

    async remove(path, id) {
      await write([op('remove', path, id)])
    },

    batch() {
      const ops = []
      return {
        set: (path, id, data, opts) => ops.push(op('set', path, id, data, opts)),
        update: (path, id, data) => ops.push(op('update', path, id, data)),
        remove: (path, id) => ops.push(op('remove', path, id)),
        createExclusive: (path, id, data) => ops.push(op('createExclusive', path, id, data)),
        commit: async () => {
          await write(ops)
        },
      }
    },

    async runTransaction(fn) {
      const MAX_ATTEMPTS = 5
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const reads = []
        const staged = []
        let wrote = false
        const tx = {
          get: async (path, id) => {
            if (wrote)
              throw fail(
                'invalid-argument',
                'postgres: every tx.get must precede the first tx write'
              )
            const p = collectionPath(path)
            guard(p)
            const docId = documentId(id)
            const row = await io.get(p, docId, { rev: true })
            reads.push({ path: p, id: docId, rev: row ? row.rev : 0 })
            return row ? row.data : null
          },
          set: (path, id, data, opts) => {
            wrote = true
            staged.push(op('set', path, id, data, opts))
          },
          update: (path, id, data) => {
            wrote = true
            staged.push(op('update', path, id, data))
          },
          remove: (path, id) => {
            wrote = true
            staged.push(op('remove', path, id))
          },
        }
        const result = await fn(tx)
        const committed = await io.commit(staged, reads)
        if (committed?.stale) continue
        wake(committed?.paths || [])
        return result
      }
      throw fail('aborted', `postgres: transaction contended after ${MAX_ATTEMPTS} attempts`)
    },

    isWriteRefused(e) {
      const code = e?.code
      return code === 'permission-denied' || code === 'already-exists'
    },

    _refuse(matcher) {
      if (matcher == null) refuseMatch = null
      else if (typeof matcher === 'function') refuseMatch = matcher
      else refuseMatch = (p) => p === matcher || p.startsWith(`${matcher}/`)
      for (const l of listeners) dirty.add(l)
      scheduleFlush()
    },

    async _reset() {
      for (const l of listeners) l.closed = true
      listeners.clear()
      dirty.clear()
      refuseMatch = null
      if (io.truncate) await io.truncate()
    },

    /** Test hook: resolves when subscriber work started by the last flush has finished. */
    _idle: whenIdle,
  }
}

function engineIo(engine, session) {
  return {
    get: (path, id, opts) => engine.get(session, path, id, opts),
    list: (path, opts) => engine.list(session, path, opts),
    count: (path, opts) => engine.count(session, path, opts),
    commit: (ops, expect) => engine.commit(session, ops, expect || []),
    truncate: () => engine.truncate(),
  }
}

export function createPostgresAdapter(engine, session = null) {
  return buildAdapter(engineIo(engine, session))
}

export const DATA_REQUEST_TIMEOUT_MS = 15_000

function httpIo(baseUrl) {
  const root = String(baseUrl || '').replace(/\/$/, '')
  async function call(body) {
    if (!root) throw fail('failed-precondition', 'postgres: VITE_DATA_GATEWAY is not set')
    const token = currentAccessToken()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DATA_REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${root}/data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(encodeTree(body)),
        signal: controller.signal,
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        noteSessionEnded(res, payload)
        throw fail(
          payload.code || 'unavailable',
          payload.message || `data request failed (${res.status})`
        )
      }
      return payload
    } catch (err) {
      if (controller.signal.aborted) {
        throw fail('deadline-exceeded', 'The server took too long to respond. Please try again.')
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    get: async (path, id, opts) =>
      revive((await call({ op: 'get', path, id, rev: Boolean(opts?.rev) })).doc),
    list: async (path, opts) => revive((await call({ op: 'list', path, opts: opts || {} })).rows),
    count: async (path, opts) => (await call({ op: 'count', path, opts: opts || {} })).count,
    commit: async (ops, expect) => call({ op: 'commit', ops, expect: expect || [] }),
    poll: true,
  }
}

export function createHttpPostgresAdapter(baseUrl) {
  return buildAdapter(httpIo(baseUrl))
}

const gateway = runtimeEnv('DATA_GATEWAY')

export default createHttpPostgresAdapter(gateway)
