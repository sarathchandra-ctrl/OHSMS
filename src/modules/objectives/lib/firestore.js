// Targets live in organizations/{orgId}/objectives; actuals are always computed
// live from the owning modules, never entered by hand.
import {
  addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc, writeBatch,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { reserveDocId } from '../../../shared/docId/reserve'
import { logAudit, COLLECTION_READ_CAP } from '../../../shared/org/orgData'
import { KPIS } from './kpis'

const col = (orgId) => collection(db, 'organizations', orgId, 'objectives')
const ref = (orgId, id) => doc(db, 'organizations', orgId, 'objectives', id)

export function subscribeObjectives(orgId, cb) {
  return onSnapshot(query(col(orgId), orderBy('kpi'), limit(COLLECTION_READ_CAP)),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => cb([]))
}

const clean = (d) => ({
  kpi: d.kpi,
  level: d.level || 'org',
  scope: d.scope || '',           // region name / siteId; '' for org
  scopeLabel: d.scopeLabel || '',
  entity: d.entity || 'all',
  target: Number(d.target),
  period: d.period || '',
  owner: (d.owner || '').trim(),
  ownerUid: d.ownerUid || '',
  notes: (d.notes || '').trim(),
})

const label = (d) => `${KPIS.find((k) => k.key === d.kpi)?.label || d.kpi} · ${d.scopeLabel || 'Organization'}`

export async function addObjective(orgId, data, actor) {
  const r = await addDoc(col(orgId), { ...clean(data), docId: await reserveDocId(orgId, 'objectives'), createdAt: serverTimestamp(), createdBy: actor?.uid || null })
  await logAudit(orgId, actor, 'objective.create', {
    module: 'objectives', target: 'objective', targetId: r.id, targetLabel: label(data),
    summary: `Set target ${data.target} for ${label(data)}`,
  })
  return r.id
}

export async function updateObjective(orgId, id, data, actor) {
  await updateDoc(ref(orgId, id), { ...clean(data), updatedAt: serverTimestamp() })
  await logAudit(orgId, actor, 'objective.update', {
    module: 'objectives', target: 'objective', targetId: id, targetLabel: label(data),
    summary: `Updated target to ${data.target} for ${label(data)}`,
  })
}

export async function deleteObjective(orgId, id, actor, lbl) {
  await deleteDoc(ref(orgId, id))
  await logAudit(orgId, actor, 'objective.delete', {
    module: 'objectives', target: 'objective', targetId: id, targetLabel: lbl,
    summary: `Removed target for ${lbl}`,
  })
}

/** Seed one org-level target per KPI at its default, for orgs starting out. */
export async function seedDefaultTargets(orgId, period, actor) {
  const batch = writeBatch(db)
  for (const k of KPIS) {
    batch.set(doc(col(orgId)), {
      ...clean({ kpi: k.key, level: 'org', scope: '', scopeLabel: 'Organization', entity: 'all', target: k.defaultTarget, period }),
      docId: await reserveDocId(orgId, 'objectives'),
      createdAt: serverTimestamp(), createdBy: actor?.uid || null,
    })
  }
  await batch.commit()
  await logAudit(orgId, actor, 'objective.seed', {
    module: 'objectives', target: 'objective', targetLabel: 'Organization',
    summary: `Seeded ${KPIS.length} organization-level targets for ${period}`,
  })
  return KPIS.length
}
