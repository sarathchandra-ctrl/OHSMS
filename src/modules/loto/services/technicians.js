import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  limit,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { openSnapshots, sealDoc } from '../../../shared/crypto'

const COL = 'technicians'

export function subscribeTechnicians(orgId, cb, onError) {
  const q = query(collection(db, COL), where('orgId', '==', orgId), limit(COLLECTION_READ_CAP))
  // name and contact are sealed at rest, so the list is opened before it is
  // sorted: sorting the ciphertext would order people by random bytes.
  const opened = openSnapshots(orgId, COL, (items) => {
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    cb(items)
  })
  return onSnapshot(q, (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError)
}

export async function addTechnician({
  orgId, name, lockNo, contact, licenceNo, licenceExp, licencePhotoPath,
}, user) {
  const body = await sealDoc(orgId, COL, {
    orgId,
    name: name.trim(),
    lockNo: (lockNo || '').trim(),
    contact: (contact || '').trim(),
    licenceNo: (licenceNo || '').trim(),
    active: true,
    createdBy: user.id,
    createdAt: serverTimestamp(),
  })
  if (licenceExp) body.licenceExp = Timestamp.fromDate(new Date(`${licenceExp}T23:59:59`))
  if (licencePhotoPath) body.licencePhotoPath = licencePhotoPath
  return addDoc(collection(db, COL), body)
}

export async function updateTechnician(id, patch, orgId) {
  // Only the active flag is edited today. A patch that carries a sealed field
  // must name its org, or it would be written as plaintext into a sealed column.
  if (('name' in patch || 'contact' in patch || 'licenceNo' in patch) && !orgId) {
    throw new Error('updateTechnician needs orgId to seal name or contact')
  }
  return updateDoc(doc(db, COL, id), orgId ? await sealDoc(orgId, COL, patch) : patch)
}

export async function deleteTechnician(id) {
  return deleteDoc(doc(db, COL, id))
}
