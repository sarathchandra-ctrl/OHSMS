import { doc, getDoc } from '../../shared/data/client.js'
import { db } from '../../shared/db'

const COLLECTION = {
  extinguisher: 'extinguishers',
  aed: 'aeds',
  fas: 'fas',
  stretcher: 'stretchers',
}

export function collectionForKind(kind) {
  return COLLECTION[kind] || ''
}

/** The org record behind a mirror, or null when it is not there. */
export async function loadAssetRecord(kind, id) {
  const collectionName = collectionForKind(kind)
  if (!collectionName || !id) return null
  const snap = await getDoc(doc(db, collectionName, id))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}
