// Firestore-shaped calls, backed by the data seam.
//
// Own-stack builds import this instead of firebase/firestore. The WEEHS build
// does not: src/shared/data/client.js forwards to the SDK when the driver is
// firestore, so those call sites keep the objects their tests already mock.
// Document references here are { path, id } because the seam has no Firestore
// ref. deleteDoc(ref) becomes remove(parent, id).

import { dataProvider } from './index'
import { PgTimestamp } from './adapters/postgresWire'

function fail(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function isRef(value) {
  return (
    Boolean(value) &&
    typeof value.path === 'string' &&
    (value.kind === 'doc' || value.kind === 'col')
  )
}

function joinPath(parts) {
  return parts.filter((p) => p !== undefined && p !== null && String(p) !== '').join('/')
}

export function collection(first, ...rest) {
  if (isRef(first))
    return {
      kind: 'col',
      path: joinPath([first.path, ...rest]),
      id: rest[rest.length - 1] || first.id,
    }
  return { kind: 'col', path: joinPath(rest), id: rest[rest.length - 1] }
}

export function doc(first, ...rest) {
  if (isRef(first) && first.kind === 'col' && rest.length === 0) {
    const id = dataProvider.newId(first.path)
    return { kind: 'doc', path: `${first.path}/${id}`, id }
  }
  if (isRef(first)) {
    const path = joinPath([first.path, ...rest])
    const id = path.split('/').pop()
    return { kind: 'doc', path, id }
  }
  const path = joinPath(rest)
  return { kind: 'doc', path, id: path.split('/').pop() }
}

function splitDoc(ref) {
  const parts = String(ref.path || '').split('/')
  const id = parts.pop()
  return { path: parts.join('/'), id }
}

function snapshot(ref, row) {
  const data = row ? (({ id: _id, ...rest }) => rest)(row) : undefined
  return {
    id: ref.id,
    ref,
    exists: () => row != null,
    data: () => (row ? data : undefined),
  }
}

export async function getDoc(ref) {
  const { path, id } = splitDoc(ref)
  return snapshot(ref, await dataProvider.get(path, id))
}

export async function getDocs(target) {
  const rows = await dataProvider.list(target.path, target.opts || {})
  const docs = rows.map((row) =>
    snapshot({ kind: 'doc', path: `${target.path}/${row.id}`, id: row.id }, row)
  )
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (fn) => docs.forEach(fn),
  }
}

export async function getCountFromServer(target) {
  const count = await dataProvider.count(target.path, target.opts || {})
  return { data: () => ({ count }) }
}

function constraintsOf(parts) {
  const opts = { where: [] }
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'where')
      opts.where.push({ field: part.field, op: part.op, value: part.value })
    if (part.type === 'orderBy') opts.orderBy = [part.field, part.dir || 'asc']
    if (part.type === 'limit') opts.limit = part.n
  }
  if (!opts.where.length) delete opts.where
  return opts
}

export function query(col, ...parts) {
  return { kind: 'col', path: col.path, id: col.id, opts: constraintsOf(parts) }
}
export function where(field, op, value) {
  return { type: 'where', field, op, value }
}
export function orderBy(field, dir = 'asc') {
  return { type: 'orderBy', field, dir }
}
export function limit(n) {
  return { type: 'limit', n }
}

export function onSnapshot(target, onNext, onError) {
  if (typeof onNext !== 'function') {
    throw new TypeError('onSnapshot requires a callback function')
  }
  if (target.kind === 'doc') {
    return dataProvider.subscribeDoc(
      splitDoc(target).path,
      target.id,
      (row) => onNext(snapshot(target, row)),
      onError
    )
  }
  return dataProvider.subscribe(
    target.path,
    target.opts || {},
    (rows) => {
      const docs = rows.map((row) =>
        snapshot({ kind: 'doc', path: `${target.path}/${row.id}`, id: row.id }, row)
      )
      onNext({
        docs,
        size: docs.length,
        empty: docs.length === 0,
        forEach: (fn) => docs.forEach(fn),
      })
    },
    onError
  )
}

export const serverTimestamp = () => dataProvider.serverTimestamp()
export const increment = (n) => dataProvider.increment(n)
export const arrayUnion = (...values) => dataProvider.arrayUnion(...values)
export const deleteField = () => dataProvider.deleteField()
export const Timestamp = PgTimestamp

function updateFields(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]))
    return args[0]
  const out = {}
  for (let i = 0; i < args.length; i += 2) out[args[i]] = args[i + 1]
  return out
}

export async function setDoc(ref, data, opts) {
  const { path, id } = splitDoc(ref)
  await dataProvider.set(path, id, data, opts)
}

export async function addDoc(col, data) {
  const id = await dataProvider.create(col.path, data)
  return { kind: 'doc', path: `${col.path}/${id}`, id }
}

export async function updateDoc(ref, ...args) {
  const { path, id } = splitDoc(ref)
  await dataProvider.update(path, id, updateFields(args))
}

export async function deleteDoc(ref) {
  const { path, id } = splitDoc(ref)
  await dataProvider.remove(path, id)
}

export function writeBatch() {
  const batch = dataProvider.batch()
  return {
    set(ref, data, opts) {
      const { path, id } = splitDoc(ref)
      batch.set(path, id, data, opts)
    },
    update(ref, ...args) {
      const { path, id } = splitDoc(ref)
      batch.update(path, id, updateFields(args))
    },
    delete(ref) {
      const { path, id } = splitDoc(ref)
      batch.remove(path, id)
    },
    commit: () => batch.commit(),
  }
}

export function runTransaction(_db, fn) {
  return dataProvider.runTransaction(async (tx) =>
    fn({
      get: async (ref) => {
        const { path, id } = splitDoc(ref)
        return snapshot(ref, await tx.get(path, id))
      },
      set: (ref, data, opts) => {
        const { path, id } = splitDoc(ref)
        tx.set(path, id, data, opts)
      },
      update: (ref, ...args) => {
        const { path, id } = splitDoc(ref)
        tx.update(path, id, updateFields(args))
      },
      delete: (ref) => {
        const { path, id } = splitDoc(ref)
        tx.remove(path, id)
      },
    })
  )
}

export function arrayRemove() {
  throw fail('unimplemented', 'postgres client: arrayRemove is not used by this app')
}
