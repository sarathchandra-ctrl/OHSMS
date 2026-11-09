import { collection, onSnapshot, orderBy, query, limit } from '../../../shared/data/client.js'
import { onReadError } from '../../../shared/org/readError'
import { db } from '../../../shared/db'

// Reads only. The write path that used to live here — createAudit,
// updateAudit, deleteAudit, subscribeAudit, and the ISO 45001 clause checklist
// they seeded — belonged to an EARLIER data model and nothing called it.
//
// The Internal Audit module people actually use writes to auditPlans and
// auditFindings through services/auditModule.js. These `audits` documents are
// still subscribed to by OrgDataContext, so the read stays; the unreachable
// half was removed rather than left looking like a supported way in.
const col = (orgId) => collection(db, 'organizations', orgId, 'audits')

export function subscribeAudits(orgId, callback) {
  const q = query(col(orgId), orderBy('scheduledDate', 'asc'), limit(1000))
  return onSnapshot(
    q,
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onReadError('audits', callback),
  )
}
