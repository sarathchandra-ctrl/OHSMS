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
  limit,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { openSnapshots, sealDoc } from '../../../shared/crypto'

const COL = 'technicians'

export function subscribeTechnicians(cb, onError) {
  const q = query(collection(db, COL), limit(COLLECTION_READ_CAP))
  // name and contact are sealed at rest, so the list is opened before it is
  // sorted: sorting the ciphertext would order people by random bytes.
  const opened = openSnapshots(COL, (items) => {
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    cb(items)
  })
  return onSnapshot(q, (snap) => opened(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError)
}

export async function addTechnician({
  name, lockNo, contact, licenceNo, licenceExp, licencePhotoPath,
}, user) {
  const body = await sealDoc(COL, {
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

export async function updateTechnician(id, patch) {
  return updateDoc(doc(db, COL, id), (await sealDoc(COL, patch)))
}

export async function deleteTechnician(id) {
  return deleteDoc(doc(db, COL, id))
}
