// Admin → Maintenance → "Record the site on older records". Reads each
// collection that names its site in text, plans a siteId with
// stack/lib/siteBackfill.js, and writes it. Run as an administrator, who
// reaches every site. Once a record carries a siteId, the server restricts it
// to the people who reach that site (stack/policy.mjs siteBlocked).
import { collection, doc, getDocs, limit, query, writeBatch } from '../data/client.js'
import { db } from '../db'
import { openDocs } from '../crypto'
import { COLLECTION_READ_CAP } from './orgData'
import { SITE_TEXT_FIELDS, planSiteBackfill } from '../../../stack/lib/siteBackfill.js'

export async function backfillSiteIds({ dryRun = true } = {}) {
  const read = async (name) => {
    const snap = await getDocs(query(collection(db, name), limit(COLLECTION_READ_CAP)))
    // Opened, because a site field may be sealed; openDocs passes plain
    // collections through untouched.
    return openDocs(name, snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  }
  const sites = await read('sites')
  const rows = {}
  for (const name of Object.keys(SITE_TEXT_FIELDS)) rows[name] = await read(name)
  const plan = planSiteBackfill(rows, sites)
  let written = 0
  if (!dryRun) {
    for (let i = 0; i < plan.writes.length; i += 400) {
      const batch = writeBatch(db)
      const slice = plan.writes.slice(i, i + 400)
      for (const w of slice) batch.update(doc(db, w.collection, w.id), { siteId: w.siteId })
      await batch.commit()
      written += slice.length
    }
  }
  return { ...plan, written }
}
