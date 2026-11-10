// ─────────────────────────────────────────────────────────────────────────────
// In-memory adapter — implements the data provider contract (see ../index.js).
//
// It is here for the reason adapters/s3.js is in the storage seam: a contract
// with one implementation is a description of that implementation. A second
// driver is what turns it into a contract. Everything Firestore hands over for
// free — a create that fails on collision, an all-or-nothing batch, a
// read-modify-write that cannot interleave, a server clock — is earned here in
// plain JavaScript, and anything that could not be earned would have been a
// Firestore assumption hiding in the contract rather than a requirement.
//
// It needs no emulator and therefore no JDK, so the contract suite is a plain
// `npx vitest run`.
//
// NOT a production store: one process, one heap, gone when the tab closes, no
// tenancy enforcement of any kind (on Firestore the RULES are the boundary, and
// this driver has no equivalent). Select it with VITE_DATA_DRIVER=memory for
// tests, demos and offline UI work only.
//
// Where it deliberately differs from Firestore — read this before trusting a
// green test as proof the app works on Firestore:
//
//   1. orderBy KEEPS documents missing the ordered field (sorted last).
//      Firestore drops them, which orgData.js:275 and cctv/lib/data.js:38
//      both rely on knowing. Emulating the drop would mean this driver silently
//      hiding rows too; showing an extra row is the failure you can see.
//   2. A subscriber may be woken by a write that does not change its result
//      set. Firestore only fires when the query result changes. "Callback fired"
//      has never meant "something you asked about changed" — do not start
//      relying on it now.
//   3. Values read back are the values written (with sentinels resolved). The
//      contract does not normalise the timestamp read shape, so serverTimestamp
//      resolves to something carrying `.seconds` / `.toMillis()` / `.toDate()`
//      — the shape the app's sorts already read. That is a Firestore shape
//      leaking through the contract, not a promise this driver wanted to make.
// ─────────────────────────────────────────────────────────────────────────────

// ── Errors ───────────────────────────────────────────────────────────────────

function fail(code, message) {
  const e = new Error(message)
  e.code = code // callers branch on e.code, so the shape must survive
  return e
}

// ── Values ───────────────────────────────────────────────────────────────────

const isPlainObject = (v) =>
  Boolean(v) &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

// Structural clone that leaves class instances (timestamps, blobs) alone. Every
// read hands out a copy: a caller that mutates the row it rendered must not be
// able to reach into the store and change what the next reader sees — on
// Firestore each snapshot is fresh, and code written against that would corrupt
// this one silently.
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone)
  if (v instanceof Date) return new Date(v.getTime())
  if (isPlainObject(v)) {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = deepClone(val)
    return out
  }
  return v
}

/**
 * [seconds, nanoseconds] for anything time-shaped (Date, Firestore Timestamp,
 * this driver's own), else null.
 *
 * Whole seconds plus nanoseconds rather than milliseconds because milliseconds
 * throw away the ordering the write path took care to create: several documents
 * written inside one millisecond would compare equal, and a comparator that
 * returns 0 leaves the original order, so an ordered list looks right and is not.
 */
function timeParts(v) {
  const split = (ms) => {
    const s = Math.floor(ms / 1000)
    return [s, (ms - s * 1000) * 1e6]
  }
  if (v instanceof Date) return split(v.getTime())
  if (!v || typeof v !== 'object') return null
  if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number') return [v.seconds, v.nanoseconds]
  if (typeof v.toMillis === 'function') return split(v.toMillis())
  return null
}

function deepEqual(a, b) {
  if (a === b) return true
  const ta = timeParts(a)
  const tb = timeParts(b)
  if (ta !== null || tb !== null) return Boolean(ta && tb) && ta[0] === tb[0] && ta[1] === tb[1]
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

// Ordering across types is something no query in this app does; within a type is
// what orderBy actually needs. Nulls first, then booleans, then anything
// numeric-or-time, then strings — arrays and maps compare equal, which leaves
// them in their existing order rather than inventing one.
const typeRank = (v) => {
  if (v === null || v === undefined) return 0
  if (typeof v === 'boolean') return 1
  if (typeof v === 'number' || timeParts(v) !== null) return 2
  if (typeof v === 'string') return 3
  return 4
}

const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

function compareValues(a, b) {
  const ra = typeRank(a)
  const rb = typeRank(b)
  if (ra !== rb) return ra - rb
  if (ra === 1) return (a ? 1 : 0) - (b ? 1 : 0)
  if (ra === 2) {
    const pa = timeParts(a)
    const pb = timeParts(b)
    if (pa && pb) return pa[0] === pb[0] ? cmp(pa[1], pb[1]) : cmp(pa[0], pb[0])
    // A number against a timestamp is not something any query in this app does;
    // seconds keep the two at least self-consistent rather than throwing.
    return cmp(pa ? pa[0] : a, pb ? pb[0] : b)
  }
  if (ra === 3) return cmp(a, b)
  return 0
}

// ── Timestamps ───────────────────────────────────────────────────────────────

/**
 * What serverTimestamp() resolves to. Frozen, so a shared read cannot be
 * mutated, and it answers `.seconds` / `.toMillis()` / `.toDate()` because
 * that is what the app's existing sorts and formatters read off a Firestore
 * Timestamp (see the contract's "what stays out": normalising the read shape is
 * a separate task with a migration attached).
 */
class MemoryTimestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds
    this.nanoseconds = nanoseconds
    Object.freeze(this)
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)
  }
  toDate() {
    return new Date(this.toMillis())
  }
  toJSON() {
    return this.toDate().toISOString()
  }
}

// Strictly increasing, not merely "now". Date.now() has millisecond resolution
// and a test (or a fast batch) writes several documents inside one millisecond;
// equal timestamps make an ordered read a coin flip, and a comparator that
// returns 0 for everything leaves the original order, so the list looks right
// and is simply wrong. Microsecond ticks keep write order recoverable.
let lastMicros = 0
function nextTimestamp() {
  const micros = Math.max(Date.now() * 1000, lastMicros + 1)
  lastMicros = micros
  return new MemoryTimestamp(Math.floor(micros / 1e6), (micros % 1e6) * 1000)
}

// ── Sentinels ────────────────────────────────────────────────────────────────
//
// Opaque to callers, which only ever drop them into a write payload. They are
// resolved at write time against whatever the field held before, which is the
// whole point of increment(): the caller never read the old value, so two
// writers cannot lose each other's delta.

const KIND = Symbol('memory.sentinel')
const sentinel = (kind, value) => Object.freeze({ [KIND]: kind, value })
const isSentinel = (v) => Boolean(v) && typeof v === 'object' && KIND in v

function resolveSentinel(s, prev) {
  switch (s[KIND]) {
    case 'serverTimestamp':
      return nextTimestamp()
    case 'increment':
      // A non-numeric (or absent) field is replaced by the delta, as Firestore
      // does — an increment must never fail a write it is riding along with.
      return (typeof prev === 'number' ? prev : 0) + s.value
    case 'arrayUnion': {
      const base = Array.isArray(prev) ? [...prev] : []
      for (const v of s.value) if (!base.some((x) => deepEqual(x, v))) base.push(deepClone(v))
      return base
    }
    default:
      throw fail('invalid-argument', `memory: unknown sentinel ${String(s[KIND])}`)
  }
}

/** Resolve sentinels in a value tree; `prev` supplies each field's old value. */
function resolveTree(value, prev) {
  if (isSentinel(value)) return resolveSentinel(value, prev)
  if (Array.isArray(value)) return value.map((v) => resolveTree(v, undefined))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveTree(v, isPlainObject(prev) ? prev[k] : undefined)
    }
    return out
  }
  return deepClone(value)
}

/** set(..., {merge:true}): named fields only, nested maps merged, arrays replaced. */
function mergeTree(prev, value) {
  if (isSentinel(value)) return resolveSentinel(value, prev)
  if (isPlainObject(value)) {
    const base = isPlainObject(prev) ? deepClone(prev) : {}
    for (const [k, v] of Object.entries(value)) base[k] = mergeTree(base[k], v)
    return base
  }
  return resolveTree(value, prev)
}

// Firestore refuses `undefined` as a field value (this app does not enable
// ignoreUndefinedProperties), so this driver refuses it too. A memory driver
// that quietly accepts what production rejects would let a bug pass every test
// and fail on deploy — which is the one thing a proving-ground driver may not do.
function assertWritable(value, trail = '') {
  if (value === undefined) {
    throw fail('invalid-argument', `memory: undefined is not a value (field ${trail || '<root>'})`)
  }
  if (isSentinel(value) || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertWritable(v, `${trail}[${i}]`))
    return
  }
  if (!isPlainObject(value)) return // Date, Blob, Timestamp — stored as-is
  for (const [k, v] of Object.entries(value)) assertWritable(v, trail ? `${trail}.${k}` : k)
}

// ── Field paths ──────────────────────────────────────────────────────────────
//
// Dotted keys in update() address nested fields — `byStatus.active` reaches
// into the map without rewriting its siblings, which is what the stats deltas
// depend on. In set() a dot is an ordinary character in a field name, exactly as
// Firestore treats it; the two are not interchangeable.

function getPath(obj, segs) {
  let cur = obj
  for (const s of segs) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined
    cur = cur[s]
    if (cur === undefined) return undefined
  }
  return cur
}

function setPath(obj, segs, value) {
  let cur = obj
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (!isPlainObject(cur[segs[i]])) cur[segs[i]] = {}
    cur = cur[segs[i]]
  }
  cur[segs[segs.length - 1]] = value
}

// ── Queries ──────────────────────────────────────────────────────────────────

const OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'])

// Loud, not lenient. A filter this driver did not understand, dropped silently,
// turns a scoped read into an unscoped one — on the documents library that is
// the difference between "the sites you may see" and "everything".
function validateOpts(opts = {}) {
  for (const c of opts.where || []) {
    if (!c || !c.field) throw fail('invalid-argument', 'memory: a where entry needs a field')
    if (!OPS.has(c.op)) throw fail('invalid-argument', `memory: unsupported where op '${c?.op}'`)
    if ((c.op === 'in' || c.op === 'not-in' || c.op === 'array-contains-any') && !Array.isArray(c.value)) {
      throw fail('invalid-argument', `memory: '${c.op}' needs an array of values`)
    }
  }
  if (opts.orderBy && (!Array.isArray(opts.orderBy) || !opts.orderBy[0])) {
    throw fail('invalid-argument', 'memory: orderBy is [field, "asc"|"desc"]')
  }
}

function matches(row, { field, op, value }) {
  const actual = getPath(row, String(field).split('.'))
  switch (op) {
    case '==':
      // A MISSING field does not equal null here, because `undefined` is not
      // `null` in JS — which happens to be exactly Firestore's rule, and is why
      // backfillDeletedAt exists. A SQL adapter with `IS NULL` will not agree.
      return deepEqual(actual, value)
    case '!=':
      return actual !== undefined && !deepEqual(actual, value)
    case 'in':
      return value.some((v) => deepEqual(actual, v))
    case 'not-in':
      return actual !== undefined && !value.some((v) => deepEqual(actual, v))
    case 'array-contains':
      return Array.isArray(actual) && actual.some((v) => deepEqual(v, value))
    case 'array-contains-any':
      return Array.isArray(actual) && value.some((v) => actual.some((x) => deepEqual(x, v)))
    default: {
      if (actual === undefined) return false // a range filter requires the field
      const c = compareValues(actual, value)
      if (op === '<') return c < 0
      if (op === '<=') return c <= 0
      if (op === '>') return c > 0
      return c >= 0
    }
  }
}

function applyOpts(rows, opts = {}) {
  let out = rows
  for (const c of opts.where || []) out = out.filter((r) => matches(r, c))
  if (opts.orderBy) {
    const [field, dir = 'asc'] = opts.orderBy
    const sign = dir === 'desc' ? -1 : 1
    const segs = String(field).split('.')
    out = [...out].sort((a, b) => {
      const va = getPath(a, segs)
      const vb = getPath(b, segs)
      // Rows missing the ordered field sort last in BOTH directions, so they
      // never displace real data at the head of a capped list. Firestore drops
      // them entirely; see the header for why this driver does not.
      if (va === undefined || vb === undefined) {
        return va === vb ? 0 : va === undefined ? 1 : -1
      }
      return sign * compareValues(va, vb)
    })
  } else {
    // Firestore's default order is by document id, not insertion order. Matching
    // it keeps a paged read from looking stable here and shuffled in production.
    out = [...out].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1))
  }
  if (opts.limit) out = out.slice(0, opts.limit)
  return out
}

// ── Ids ──────────────────────────────────────────────────────────────────────

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomId() {
  const bytes = new Uint8Array(20)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('')
}

// ── Paths ────────────────────────────────────────────────────────────────────

function normalizePath(path) {
  const segs = String(path || '').split('/').filter(Boolean)
  if (!segs.length) throw fail('invalid-argument', 'memory: empty collection path')
  // Collection paths alternate collection/document and therefore have an odd
  // number of segments. Passing a DOCUMENT path where a collection belongs
  // would otherwise create a parallel universe of rows nothing ever reads.
  if (segs.length % 2 === 0) {
    throw fail('invalid-argument', `memory: '${path}' is a document path, not a collection`)
  }
  return segs.join('/')
}

function assertId(id) {
  const s = String(id ?? '')
  if (!s) throw fail('invalid-argument', 'memory: a document id is required')
  // An id carrying a slash silently addresses a different collection — which on
  // this app means a different tenant's namespace.
  if (s.includes('/')) throw fail('invalid-argument', `memory: '${s}' is not a document id`)
  return s
}

// ── The adapter ──────────────────────────────────────────────────────────────

export function createMemoryAdapter() {
  const store = new Map() // collection path -> Map(id -> data)
  const versions = new Map() // document key -> write counter, survives deletion
  const colWatchers = new Map() // collection path -> Set(listener)
  const docWatchers = new Map() // document key   -> Set(listener)

  const dirty = new Set()
  let flushQueued = false
  let refuseMatch = null

  // Version checks and listener wake-ups are looked up by this key, so the two
  // halves must not be able to blur into each other. '/' is safe precisely
  // because assertId refuses an id containing one — the key is the document path.
  const dkey = (path, id) => `${path}/${id}`
  const refused = (path) => Boolean(refuseMatch) && refuseMatch(path)

  function guard(path) {
    if (refused(path)) throw fail('permission-denied', `memory: '${path}' is refused (test seam)`)
  }

  const versionOf = (k) => versions.get(k) || 0
  const rawDoc = (path, id) => store.get(path)?.get(id)

  function rowsOf(path) {
    const col = store.get(path)
    if (!col) return []
    return [...col.entries()].map(([id, data]) => ({ id, ...deepClone(data) }))
  }

  // ── Notification ───────────────────────────────────────────────────────────
  //
  // Writes land synchronously; listeners are woken on a microtask. That gap is
  // load-bearing twice over: a batch or transaction applies every op before
  // anything can observe it (so all-or-nothing holds for readers, not just for
  // storage), and the first emission of a new subscription is asynchronous like
  // Firestore's — a caller that sets state inside the callback must not be able
  // to have that run before its own subscribe() call has returned.

  function scheduleFlush() {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(flush)
  }

  function wake(path, id) {
    for (const l of colWatchers.get(path) || []) dirty.add(l)
    for (const l of docWatchers.get(dkey(path, id)) || []) dirty.add(l)
    scheduleFlush()
  }

  function flush() {
    flushQueued = false
    const batch = [...dirty]
    dirty.clear()
    for (const l of batch) emit(l)
  }

  function emit(l) {
    if (l.closed) return
    if (refused(l.path)) {
      // A dead listener that says nothing renders as "no data" rather than "not
      // loaded" — the most dangerous way to be wrong on a safety system. Close
      // it and tell the caller, as onSnapshot does.
      detach(l)
      l.onError?.(fail('permission-denied', `memory: '${l.path}' is refused (test seam)`))
      return
    }
    try {
      l.cb(l.id ? readDoc(l.path, l.id) : applyOpts(rowsOf(l.path), l.opts))
    } catch (e) {
      // One subscriber throwing must not silence every other subscriber waiting
      // on the same tick, and must not be swallowed either — same call as every
      // other listener failure in this app (cctv, orgData, documents).
      // eslint-disable-next-line no-console
      console.error('[memory] subscriber threw while handling a change:', e?.message || e)
    }
  }

  function attach(l) {
    const map = l.id ? docWatchers : colWatchers
    const k = l.id ? dkey(l.path, l.id) : l.path
    if (!map.has(k)) map.set(k, new Set())
    map.get(k).add(l)
  }

  function detach(l) {
    l.closed = true
    const map = l.id ? docWatchers : colWatchers
    const k = l.id ? dkey(l.path, l.id) : l.path
    const set = map.get(k)
    if (set) {
      set.delete(l)
      if (!set.size) map.delete(k)
    }
    dirty.delete(l)
  }

  const readDoc = (path, id) => {
    const data = rawDoc(path, id)
    return data === undefined ? null : { id, ...deepClone(data) }
  }

  // ── Raw writes (already validated; never awaits, so nothing interleaves) ────

  function putDoc(path, id, data) {
    let col = store.get(path)
    if (!col) {
      col = new Map()
      store.set(path, col)
    }
    col.set(id, data)
    const k = dkey(path, id)
    versions.set(k, versionOf(k) + 1)
    wake(path, id)
  }

  function dropDoc(path, id) {
    const col = store.get(path)
    if (!col?.has(id)) return // deleting a missing document changed nothing
    col.delete(id)
    if (!col.size) store.delete(path)
    const k = dkey(path, id)
    versions.set(k, versionOf(k) + 1)
    wake(path, id)
  }

  /** The value a write op would store, resolved against what is there now. */
  function nextValue(op) {
    const prev = rawDoc(op.path, op.id)
    if (op.type === 'update') {
      const out = deepClone(prev)
      for (const [key, value] of Object.entries(op.data)) {
        const segs = String(key).split('.')
        setPath(out, segs, resolveTree(value, getPath(out, segs)))
      }
      return out
    }
    if (op.merge) return mergeTree(prev, op.data)
    return resolveTree(op.data, undefined) // wholesale replace; increments start at 0
  }

  // Ops are validated as a GROUP — against a projection of what exists as the
  // group applies in order — and only then written. That is what makes a batch
  // all-or-nothing rather than "mostly": validating each op as it lands would
  // leave the earlier ones applied when a later one fails. Updates need the
  // check as much as exclusive creates do, because Firestore fails the whole
  // commit on an update to a document that is not there.
  function validateOps(ops) {
    const existsAfter = new Map()
    for (const op of ops) {
      const k = dkey(op.path, op.id)
      const exists = existsAfter.has(k) ? existsAfter.get(k) : rawDoc(op.path, op.id) !== undefined
      if (op.type === 'createExclusive' && exists) {
        throw fail('already-exists', `memory: ${op.path}/${op.id} already exists`)
      }
      if (op.type === 'update' && !exists) {
        throw fail('not-found', `memory: no document to update at ${op.path}/${op.id}`)
      }
      existsAfter.set(k, op.type !== 'remove')
    }
  }

  function applyOps(ops) {
    for (const op of ops) {
      if (op.type === 'remove') dropDoc(op.path, op.id)
      else putDoc(op.path, op.id, nextValue(op))
    }
  }

  /** Normalise + validate one write op. Throws before anything is staged. */
  function makeOp(type, path, id, data, opts) {
    const p = normalizePath(path)
    guard(p)
    const docId = assertId(id)
    if (type !== 'remove') {
      if (!isPlainObject(data)) throw fail('invalid-argument', `memory: ${type} needs an object`)
      assertWritable(data)
    }
    return { type, path: p, id: docId, data, merge: Boolean(opts?.merge) }
  }

  const commitOps = (ops) => {
    validateOps(ops)
    applyOps(ops)
  }

  // Not a method on the returned object: create() needs it, and a `this` that
  // breaks the moment someone destructures the provider is not worth the risk.
  function mintId(path) {
    const p = normalizePath(path)
    let id = randomId()
    while (store.get(p)?.has(id)) id = randomId()
    return id
  }

  return {
    name: 'memory',

    // ── Sentinels ────────────────────────────────────────────────────────────
    serverTimestamp: () => sentinel('serverTimestamp'),
    increment: (n) => sentinel('increment', Number(n) || 0),
    arrayUnion: (...values) => sentinel('arrayUnion', values),

    // ── Reads ────────────────────────────────────────────────────────────────

    async get(path, id) {
      const p = normalizePath(path)
      guard(p)
      return readDoc(p, assertId(id))
    },

    async list(path, opts) {
      const p = normalizePath(path)
      guard(p)
      validateOpts(opts)
      return applyOpts(rowsOf(p), opts)
    },

    async count(path, opts) {
      const p = normalizePath(path)
      guard(p)
      validateOpts(opts)
      // A real number, never null: this driver holds every row already, so
      // there is nothing it cannot count. `null` is for drivers that can't.
      return applyOpts(rowsOf(p), opts).length
    },

    subscribe(path, opts, cb, onError) {
      const p = normalizePath(path)
      // Malformed options throw HERE, synchronously, like Firestore's query
      // builder — not later, into an onError nobody attached.
      validateOpts(opts)
      const l = { path: p, id: null, opts: opts || {}, cb, onError, closed: false }
      attach(l)
      dirty.add(l)
      scheduleFlush()
      // Returned synchronously. Every caller unsubscribes in a cleanup that may
      // run before the first emission, and none of them can await for it.
      return () => detach(l)
    },

    subscribeDoc(path, id, cb, onError) {
      const p = normalizePath(path)
      const l = { path: p, id: assertId(id), opts: {}, cb, onError, closed: false }
      attach(l)
      dirty.add(l)
      scheduleFlush()
      return () => detach(l)
    },

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * A usable id before the write, which is what the QR mirrors need: the id
     * goes into the public document in the SAME batch as the record it mirrors.
     * Synchronous and I/O-free — a caller that had to await this could not build
     * that batch.
     */
    newId: mintId,

    async create(path, data) {
      const id = mintId(path)
      commitOps([makeOp('createExclusive', path, id, data)])
      return id
    },

    async set(path, id, data, opts) {
      commitOps([makeOp('set', path, id, data, opts)])
    },

    /**
     * Create, or fail because it is already there — atomically. Never a get
     * followed by a set: this backs the fire defect lock, and the lock is the
     * only thing standing between one fault and the same fault reported twice.
     * Single-threaded JS gives the isolation for free here; a networked adapter
     * has to buy it (INSERT … ON CONFLICT, a PRIMARY KEY, a create-only rule).
     */
    async createExclusive(path, id, data) {
      commitOps([makeOp('createExclusive', path, id, data)])
    },

    /**
     * Rejects when the document does not exist, and that rejection is
     * load-bearing: incidents' bumpStats seeds the stats document off the back
     * of it, deliberately without nextSeq, because a merge carrying nextSeq: 0
     * would rewind the reference-number counter. An adapter that upserted here
     * would hand the next incident a number already printed on one.
     */
    async update(path, id, data) {
      commitOps([makeOp('update', path, id, data)])
    },

    async remove(path, id) {
      commitOps([makeOp('remove', path, id)])
    },

    // ── Composition ──────────────────────────────────────────────────────────

    batch() {
      const ops = []
      return {
        set: (path, id, data, opts) => ops.push(makeOp('set', path, id, data, opts)),
        update: (path, id, data) => ops.push(makeOp('update', path, id, data)),
        remove: (path, id) => ops.push(makeOp('remove', path, id)),
        createExclusive: (path, id, data) => ops.push(makeOp('createExclusive', path, id, data)),
        commit: async () => {
          // No await between the check and the write, so nothing can slip in
          // between them, and a rejected op leaves the other ops unapplied.
          commitOps(ops)
        },
      }
    },

    /**
     * Read-modify-write that cannot lose an update.
     *
     * `fn` may run more than once and must have no side effects beyond `tx` —
     * the contract says so, and this driver is where that stops being a
     * formality. Two transactions CAN interleave here: `await tx.get(...)`
     * yields the thread, so a second transaction can commit in the gap. Every
     * document read is versioned, and a commit whose reads have moved is thrown
     * away and the body re-run, which is what Firestore does over the network.
     */
    async runTransaction(fn) {
      const MAX_ATTEMPTS = 5
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const reads = new Map()
        const staged = []
        const tx = {
          get: async (path, id) => {
            // Every read before the first write, as the contract says. Firestore
            // refuses the other order outright, so a body that works here and
            // throws in production would be the exact failure this driver exists
            // to catch.
            if (staged.length) {
              throw fail('invalid-argument', 'memory: every tx.get must precede the first tx write')
            }
            const p = normalizePath(path)
            guard(p)
            const docId = assertId(id)
            const k = dkey(p, docId)
            reads.set(k, versionOf(k))
            return readDoc(p, docId)
          },
          set: (path, id, data, opts) => staged.push(makeOp('set', path, id, data, opts)),
          update: (path, id, data) => staged.push(makeOp('update', path, id, data)),
        }

        // A throw from fn propagates with nothing staged applied — LOTO throws
        // its lockout rules from inside the body and expects no write at all.
        const result = await fn(tx)

        // Synchronous from here to the last write: no await, so the version
        // check and the commit are one indivisible section.
        let stale = false
        for (const [k, v] of reads) {
          if (versionOf(k) !== v) {
            stale = true
            break
          }
        }
        if (stale) continue
        commitOps(staged)
        return result
      }
      throw fail('aborted', `memory: transaction contended after ${MAX_ATTEMPTS} attempts`)
    },

    // ── Error classification ─────────────────────────────────────────────────

    /**
     * On Firestore an exclusive-create collision is indistinguishable from a
     * rules refusal (the defect-lock path grants create only, so a duplicate
     * comes back permission-denied). This driver has a real unique constraint
     * and says already-exists — both mean "the write did not land, and it was
     * not a network problem", which is the only distinction callers make.
     */
    isWriteRefused(e) {
      const code = e?.code
      return code === 'permission-denied' || code === 'already-exists'
    },

    // ── Test seams ───────────────────────────────────────────────────────────

    /**
     * Refuse every read, write and live listener under a path, so a caller's
     * error branch can be exercised without an emulator. `matcher` is a path
     * prefix, a predicate, or null to clear. This is the ONLY way to reach the
     * onError paths that distinguish "read failed" from "there is nothing here",
     * and getting those wrong is how a page comes to claim a site has no
     * equipment.
     */
    _refuse(matcher) {
      if (matcher == null) refuseMatch = null
      else if (typeof matcher === 'function') refuseMatch = matcher
      else refuseMatch = (p) => p === matcher || p.startsWith(`${matcher}/`)
      // Wake live listeners so a refusal reaches them the way a rules change would.
      for (const set of colWatchers.values()) for (const l of set) dirty.add(l)
      for (const set of docWatchers.values()) for (const l of set) dirty.add(l)
      scheduleFlush()
    },

    /** Raw contents, for assertions that should not go through the read path. */
    _dump: () => new Map([...store].map(([p, col]) => [p, new Map(col)])),

    /** Forget everything. The module-level instance is shared, so tests need this. */
    _reset() {
      store.clear()
      versions.clear()
      for (const set of colWatchers.values()) for (const l of set) l.closed = true
      for (const set of docWatchers.values()) for (const l of set) l.closed = true
      colWatchers.clear()
      docWatchers.clear()
      dirty.clear()
      refuseMatch = null
    },
  }
}

export default createMemoryAdapter()
