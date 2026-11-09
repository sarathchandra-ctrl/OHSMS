import { collection, onSnapshot, orderBy, query, limit } from '../../../shared/data/client.js'
import { onReadError } from '../../../shared/org/readError'
import { db } from '../../../shared/db'

// Reads only — see the note in audits.js. createCapa and updateCapa were part
// of the superseded data model and had no callers.
const col = () => collection(db, 'capas')

export function subscribeCapas(callback) {
  const q = query(col(), orderBy('createdAt', 'desc'), limit(1000))
  return onSnapshot(
    q,
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('corrective actions', callback),
  )
}
