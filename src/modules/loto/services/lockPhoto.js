// A permit's lock photo is stored the same way a procedure photo is: a file
// under the org prefix and a procedurePhotos document. The permit itself only
// keeps the path, which the one-year purge deletes.
import { doc, serverTimestamp, setDoc } from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { putFile } from '../../../shared/storage'

export async function storeLockPhoto({ orgId, permit, dataUrl }) {
  const permitNo = permit.permitNo || permit.id
  const up = await putFile(orgId, 'loto-photos', dataUrl, `${permitNo}.jpg`)
  if (!up?.path) throw new Error('Could not store the lock photo.')
  await setDoc(doc(db, 'procedurePhotos', `permitlock_${permitNo}`), {
    orgId,
    kind: 'permit-lock',
    permitNo,
    photos: { lock: { path: up.path, url: up.url || '' } },
    updatedAt: serverTimestamp(),
  })
  return { path: up.path, at: Date.now() }
}
