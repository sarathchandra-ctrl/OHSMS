// Group lockout numbers. organizations/{orgId}/lotoGroupNumbers/{no}
// An Admin registers a number. A permit claims it by setting openPermitId in
// the same commit as the permit (firestore.rules). This file only creates
// empty numbers and lists them.
import { collection, doc, onSnapshot, query, setDoc, limit } from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'

const col = (orgId) => collection(db, 'organizations', orgId, 'lotoGroupNumbers')

export function subscribeGroupNumbers(orgId, cb) {
  if (!orgId) return () => {}
  return onSnapshot(
    query(col(orgId), limit(COLLECTION_READ_CAP)),
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      rows.sort((a, b) => String(a.no || a.id).localeCompare(String(b.no || b.id)))
      cb(rows)
    },
    () => cb([]),
  )
}

export async function addGroupNumber({ orgId, no, description }) {
  const id = String(no || '').trim()
  if (!/^[A-Za-z0-9-]{1,40}$/.test(id)) throw new Error('Use letters, numbers and hyphens only.')
  await setDoc(doc(db, 'organizations', orgId, 'lotoGroupNumbers', id), {
    orgId,
    no: id,
    description: String(description || '').trim().slice(0, 200),
    openPermitId: '',
  })
}
