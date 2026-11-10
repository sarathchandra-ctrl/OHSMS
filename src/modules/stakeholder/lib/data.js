// ─────────────────────────────────────────────────────────────────────────────
// Stakeholder issues persistence.
//
// Two collections, because escalations and legal issues are owned by different
// people and answer different questions. The link between them lives on the
// legal issue only — see linkage.js for why one direction beats two.
//
// Both get document ids: unlike equipment, these ARE generated documents. A
// legal issue gets quoted in correspondence with an authority, so it needs a
// number that means something outside this app.
// ─────────────────────────────────────────────────────────────────────────────

import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, serverTimestamp,
} from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { isSessionEnd } from '../../../shared/sessionEnd'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { logAudit } from '../../../shared/org/orgData'
import { reserveDocId } from '../../../shared/docId/reserve'
import { shapeAttachments } from './attachments'

export const COLLECTIONS = {
  escalations: 'escalations',
  legalIssues: 'legalIssues',
}

const col = (name) => collection(db, name)
const ref = (name, id) => doc(db, name, id)

// Capped: these are read as a working list, and an org with years of history
// should not pull all of it into the browser to show the current ones.
const MAX = 500

function subscribe(name, cb) {
  const q = query(col(name), orderBy('createdAt', 'desc'), limit(MAX))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => {
      if (!isSessionEnd(name, err) && !isPermissionDenied(err)) {
        // eslint-disable-next-line no-console
        console.error(`[Stakeholder] ${name} listener failed:`, err?.message || err)
      }
      cb(null, err)
    }
  )
}

export const subscribeEscalations = (cb) => subscribe(COLLECTIONS.escalations, cb)
export const subscribeLegalIssues = (cb) => subscribe(COLLECTIONS.legalIssues, cb)

// ── Shapes ───────────────────────────────────────────────────────────────────
// Firestore rejects `undefined` and a half-filled form produces plenty of it,
// so every optional field is defaulted rather than omitted.

const str = (v) => String(v ?? '').trim()
const list = (v) => (Array.isArray(v) ? v : [])

/**
 * Corrective and preventive actions.
 *
 * Same shape as the incident and audit CAPA arrays, deliberately — the central
 * Action Tracker reads all of them through one extractor, and a fourth spelling
 * of "who owns this and when is it due" would mean a fourth special case there.
 *
 * A row with no description is dropped: an action nobody can read is not an
 * action, and it would sit in the tracker forever as a blank line.
 */
const capa = (v) =>
  list(v)
    .map((a) => ({
      id: str(a?.id) || `capa-${Math.random().toString(36).slice(2, 10)}`,
      description: str(a?.description),
      owner: str(a?.owner),
      dueDate: str(a?.dueDate),
      status: str(a?.status) || 'open',
      closedAt: str(a?.closedAt),
    }))
    .filter((a) => a.description)

/**
 * The people who complained.
 *
 * Kept as an array of {memberId, name, contact, note} rather than a single
 * field, because one incident routinely involves several members and recording
 * only the loudest loses the pattern — repeatMembers() reads this to find
 * someone on their fourth complaint.
 */
const members = (v) =>
  list(v)
    .map((m) => ({
      memberId: str(m?.memberId),
      name: str(m?.name),
      contact: str(m?.contact),
      note: str(m?.note),
    }))
    .filter((m) => m.memberId || m.name)

const escalationShape = (d) => ({
  title: str(d.title),
  scope: {
    siteId: str(d.scope?.siteId),
    siteName: str(d.scope?.siteName),
    region: str(d.scope?.region),
    entity: str(d.scope?.entity),
  },
  channel: str(d.channel) || 'in_person',
  severity: str(d.severity) || 'medium',
  status: str(d.status) || 'open',
  raisedOn: str(d.raisedOn),
  description: str(d.description),
  members: members(d.members),
  // "Legal notice if any" on the escalation itself — a customer may serve one
  // directly, without any authority being involved.
  legalNoticeReceived: Boolean(d.legalNoticeReceived),
  legalNoticeRef: str(d.legalNoticeRef),
  legalNoticeDate: str(d.legalNoticeDate),
  capa: capa(d.capa),
  // CCTV footage and an ethics report, if either exists. Shaped and filtered
  // here so a failed upload never persists as a dead link.
  attachments: {
    cctv: shapeAttachments(d.attachments?.cctv),
    ethics: shapeAttachments(d.attachments?.ethics),
  },
  owner: str(d.owner),
})

const legalShape = (d) => ({
  title: str(d.title),
  scope: {
    siteId: str(d.scope?.siteId),
    siteName: str(d.scope?.siteName),
    region: str(d.scope?.region),
    entity: str(d.scope?.entity),
  },
  // The one and only place the join is stored.
  escalationId: str(d.escalationId),
  incidentDate: str(d.incidentDate),
  description: str(d.description),
  departments: list(d.departments).map(str).filter(Boolean),
  departmentOther: str(d.departmentOther),
  officials: str(d.officials),
  noticeType: str(d.noticeType) || 'none',
  noticeRef: str(d.noticeRef),
  noticeDate: str(d.noticeDate),
  responseDueDate: str(d.responseDueDate),
  status: str(d.status) || 'open',
  capa: capa(d.capa),
  penaltyAmount: Number(d.penaltyAmount) || 0,
  owner: str(d.owner),
})

const SHAPES = {
  [COLLECTIONS.escalations]: escalationShape,
  [COLLECTIONS.legalIssues]: legalShape,
}
const KINDS = {
  [COLLECTIONS.escalations]: 'escalations',
  [COLLECTIONS.legalIssues]: 'legalIssues',
}
const LABELS = {
  [COLLECTIONS.escalations]: 'customer escalation',
  [COLLECTIONS.legalIssues]: 'legal issue',
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function create(name, data, actor) {
  const payload = SHAPES[name](data)
  if (!payload.title) throw new Error(`Give the ${LABELS[name]} a title`)
  const created = await addDoc(col(name), {
    ...payload,
    docId: await reserveDocId(KINDS[name]),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: actor?.uid || '',
    createdByName: actor?.name || '',
  })
  await logAudit(actor, 'stakeholder.create', {
    target: name, targetId: created.id, targetLabel: payload.title,
    summary: `Logged ${LABELS[name]}: ${payload.title}`,
  })
  return created.id
}

async function update(name, id, data, actor) {
  const payload = SHAPES[name](data)
  await updateDoc(ref(name, id), { ...payload, updatedAt: serverTimestamp() })
  await logAudit(actor, 'stakeholder.update', {
    target: name, targetId: id, targetLabel: payload.title,
    summary: `Updated ${LABELS[name]}: ${payload.title}`,
  })
}

async function remove(name, id, label, actor) {
  await deleteDoc(ref(name, id))
  await logAudit(actor, 'stakeholder.delete', {
    target: name, targetId: id, targetLabel: label,
    summary: `Deleted ${LABELS[name]}: ${label}`,
  })
}

export const addEscalation = (d, actor) => create(COLLECTIONS.escalations, d, actor)
export const updateEscalation = (id, d, actor) => update(COLLECTIONS.escalations, id, d, actor)
export const deleteEscalation = (id, label, actor) => remove(COLLECTIONS.escalations, id, label, actor)

export const addLegalIssue = (d, actor) => create(COLLECTIONS.legalIssues, d, actor)
export const updateLegalIssue = (id, d, actor) => update(COLLECTIONS.legalIssues, id, d, actor)
export const deleteLegalIssue = (id, label, actor) => remove(COLLECTIONS.legalIssues, id, label, actor)
