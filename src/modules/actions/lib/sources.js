// ─────────────────────────────────────────────────────────────────────────────
// Central Action Tracker — source adapters.
//
// Action / CAPA items live embedded inside each module's own documents in
// different shapes and with different status vocabularies. Each adapter here
// knows how to (a) read a source collection, (b) flatten its actions into one
// normalized shape, and (c) write a status change back into the source document
// so the update shows up in the originating module too.
//
// Normalized status: 'open' | 'in_progress' | 'done'.
// ─────────────────────────────────────────────────────────────────────────────
import { doc, getDoc, updateDoc } from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { subscribeOrgCollection, incompleteReadNotice } from '../../../shared/org/orgData'
import { releaseDefectLocks } from '../../fire/lib/data'
// The tracker is a cross-module READER, so it has to open what each module
// sealed. Its writes need nothing: updateActionStatus rewrites the `capa`/
// `actions` array with only `status` and `closedAt` changed, and every sealed
// value in it passes through untouched — sealDoc is idempotent, and these
// writes never go through it at all.
import { openSnapshots } from '../../../shared/crypto'
import { actionOwnerDisplay } from '../../committee/lib/actionOwner'

const dref = (name, id) => doc(db, name, id)

export const NORM_STATUS = [
  { key: 'open', label: 'Open', color: '#ef4444' },
  { key: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { key: 'done', label: 'Done', color: '#22c55e' },
]
export const NORM_BY_KEY = Object.fromEntries(NORM_STATUS.map((s) => [s.key, s]))

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const isOverdue = (due, norm, today = todayISO()) => norm !== 'done' && !!due && due < today

const nowISO = () => new Date().toISOString()

export const SOURCES = [
  {
    key: 'incidents',
    label: 'Incident',
    tone: '#dc2626',
    collection: 'incidents',
    toNorm: (s) => (s === 'closed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'closed' : n),
    // A soft-deleted incident's actions are gone with it: they used to count
    // as open and overdue here, and in the Ticket Closure KPI.
    extract: (d) =>
      (d.deletedAt ? [] : d.capa || []).filter(Boolean).map((a) => ({
        actionId: a.id,
        title: a.description || a.title || 'Corrective action',
        owner: a.owner || a.ownerName || a.responsible || '',
        due: a.dueDate || '',
        native: a.status || 'open',
        context: d.refNo || d.referenceNo || 'Incident',
        link: `/incidents/${d.id}`,
      })),
    write: async (action, native) => {
      const snap = await getDoc(dref('incidents', action.docId))
      if (!snap.exists()) throw new Error('Incident not found')
      const capa = (snap.data().capa || []).map((a) =>
        a.id === action.actionId ? { ...a, status: native, closedAt: native === 'closed' ? nowISO() : null } : a,
      )
      await updateDoc(dref('incidents', action.docId), { capa })
    },
  },
  {
    key: 'illness',
    label: 'Illness',
    tone: '#0891b2',
    collection: 'illnesses',
    toNorm: (s) => (s === 'closed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'closed' : n),
    extract: (d) =>
      (d.deletedAt ? [] : d.actions || []).filter(Boolean).map((a) => ({
        actionId: a.id,
        title: a.description || a.title || 'Corrective action',
        owner: a.owner || a.ownerName || a.responsible || '',
        due: a.dueDate || '',
        native: a.status || 'open',
        context: d.refNo || 'Illness',
        link: `/incidents/illness/${d.id}`,
      })),
    write: async (action, native) => {
      const snap = await getDoc(dref('illnesses', action.docId))
      if (!snap.exists()) throw new Error('Illness record not found')
      const actions = (snap.data().actions || []).map((a) =>
        a.id === action.actionId ? { ...a, status: native, closedAt: native === 'closed' ? nowISO() : null } : a,
      )
      await updateDoc(dref('illnesses', action.docId), { actions })
    },
  },
  {
    key: 'equipment',
    label: 'Equipment',
    tone: '#ea580c',
    collection: 'extinguishers',
    toNorm: (s) => (s === 'closed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'closed' : n),
    // An open physical defect on an extinguisher is a pending action. Interim
    // status lives in a defectStatuses map; marking Done resolves the defect
    // (removes it from the unit, same as the module's own Resolve).
    extract: (d) => {
      if (d.deletedAt) return []
      const labels = { pin: 'PIN', stand: 'Stand', hose_pipe: 'Hose Pipe Damage', handle: 'Handle Damage', empty: 'Empty', over_pressurized: 'Over Pressurized' }
      return (d.physicalDefects || []).map((k) => ({
        actionId: k,
        title: `Fix defect: ${labels[k] || k}`,
        owner: d.lastActionBy || '',
        due: '',
        native: (d.defectStatuses || {})[k] || 'open',
        context: `${d.serialNo || 'Extinguisher'}${d.centerName ? ` · ${d.centerName}` : ''}`,
        link: '/equipment/defects',
      }))
    },
    write: async (action, native) => {
      const snap = await getDoc(dref('extinguishers', action.docId))
      if (!snap.exists()) throw new Error('Extinguisher not found')
      const data = snap.data()
      const statuses = { ...(data.defectStatuses || {}) }
      if (native === 'closed') {
        const remaining = (data.physicalDefects || []).filter((k) => k !== action.actionId)
        delete statuses[action.actionId]
        await updateDoc(dref('extinguishers', action.docId), {
          physicalDefects: remaining, defectStatuses: statuses, quotation: null,
        })
        // Release the QR reporting lock too. Resolving the defect here without
        // this left the lock in place forever, so the next person to scan that
        // extinguisher for the SAME fault was told it had already been
        // reported — permanently, with no way to clear it from the app. The
        // fire module's own resolve path always did this; the tracker, which
        // resolves the identical defect, did not.
        await releaseDefectLocks(action.docId, [action.actionId])
      } else {
        statuses[action.actionId] = native
        await updateDoc(dref('extinguishers', action.docId), { defectStatuses: statuses })
      }
    },
  },
  {
    key: 'drills',
    label: 'Mock Drill',
    tone: '#7c3aed',
    collection: 'mockDrills',
    toNorm: (s) => (s === 'Closed' ? 'done' : s === 'In Progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'Closed' : n === 'in_progress' ? 'In Progress' : 'Open'),
    // Drill CAPA rows carry no stable id — index within the array is the handle.
    extract: (d) =>
      (d.capa || []).map((c, i) => ({
        actionId: i,
        title: c.action || 'CAPA action',
        owner: c.owner || '',
        due: c.due || '',
        native: c.status || 'Open',
        context: `${d.scenario || 'Drill'}${d.centerName ? ` · ${d.centerName}` : ''}`,
        link: '/mock-drills',
      })),
    write: async (action, native) => {
      const snap = await getDoc(dref('mockDrills', action.docId))
      if (!snap.exists()) throw new Error('Drill record not found')
      const capa = (snap.data().capa || []).map((c, i) =>
        i === action.actionId ? { ...c, status: native } : c,
      )
      await updateDoc(dref('mockDrills', action.docId), { capa })
    },
  },
  {
    key: 'inspections',
    label: 'Inspection',
    tone: '#0284c7',
    collection: 'inspectionRecords',
    toNorm: (s) => (s === 'closed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'closed' : n),
    // A failed checklist item (answer === 'Fail') is a corrective action. Its
    // status is tracked on the response itself via an `actionStatus` field.
    extract: (d) =>
      Object.entries(d.responses || {})
        .filter(([, r]) => r && r.answer === 'Fail')
        .map(([fieldId, r]) => ({
          actionId: fieldId,
          // The corrective action if the inspector gave one, else the old
          // shape. A tracker row saying "Extinguisher blocked" records the
          // fault; one saying "Clear the pallets and re-mark the bay" records
          // the work, which is the thing being tracked. Records written before
          // the action was asked for keep reading exactly as they did.
          title: r.action
            ? `${r.label || 'Failed check'} — ${r.action}`
            : `${r.label || 'Failed check'}${r.observation ? ` — ${r.observation}` : ''}`,
          owner: r.actionOwner || d.inspector || '',
          due: r.actionDue || '',
          native: r.actionStatus || 'open',
          context: `${d.templateTitle || 'Inspection'}${d.siteName ? ` · ${d.siteName}` : ''}`,
          link: '/inspections/records',
          // How many inspections running this same check has failed. A fault on
          // its third month is not the same problem as one found today, and
          // without this the tracker showed them identically.
          repeat: Number(r.repeatCount) || 1,
          repeatSince: r.repeatSince || '',
        })),
    write: async (action, native) => {
      const snap = await getDoc(dref('inspectionRecords', action.docId))
      if (!snap.exists()) throw new Error('Inspection record not found')
      const responses = { ...(snap.data().responses || {}) }
      const r = responses[action.actionId]
      if (!r) throw new Error('Inspection item not found')
      responses[action.actionId] = { ...r, actionStatus: native, actionClosedAt: native === 'closed' ? nowISO() : null }
      await updateDoc(dref('inspectionRecords', action.docId), { responses })
    },
  },
  {
    key: 'audit',
    label: 'Internal Audit',
    tone: '#b45309',
    collection: 'auditFindings',
    // Findings carry no status of their own initially — fall back to the audit
    // record's lifecycle status, and store a per-finding status once tracked here.
    toNorm: (s) =>
      s === 'done' || s === 'Closed'
        ? 'done'
        : s === 'in_progress' || s === 'Submitted for Verification'
          ? 'in_progress'
          : 'open',
    toNative: (n) => n,
    extract: (d) =>
      (d.findings || []).filter(Boolean).map((f) => ({
        actionId: f.id,
        title: `${f.type || 'Finding'}: ${f.desc || f.description || 'Corrective action'}${f.clause ? ` (clause ${f.clause})` : ''}`,
        owner: d.taskDetails?.auditee || d.auditor || '',
        due: f.auditeeDueDate || '',
        native: f.status || d.status || 'Reported',
        context: `${d.docId || 'Audit'}${d.taskDetails?.dept ? ` · ${d.taskDetails.dept}` : ''}`,
        link: '/audit',
      })),
    write: async (action, native) => {
      const snap = await getDoc(dref('auditFindings', action.docId))
      if (!snap.exists()) throw new Error('Audit finding not found')
      const findings = (snap.data().findings || []).map((f) =>
        f.id === action.actionId ? { ...f, status: native } : f,
      )
      await updateDoc(dref('auditFindings', action.docId), { findings })
    },
  },
  {
    key: 'committee',
    label: 'Committee',
    tone: '#2563eb',
    collection: 'consultations',
    toNorm: (s) => (s === 'Closed' ? 'done' : s === 'In Progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'Closed' : n === 'in_progress' ? 'In Progress' : 'Open'),
    // Committee actions carry no stable id — index within the doc's array is the handle.
    extract: (d) =>
      (d.actions || []).map((a, i) => ({
        actionId: i,
        title: a.action || a.description || 'Action',
        owner: actionOwnerDisplay(a),
        due: a.due || '',
        native: a.status || 'Open',
        context: d.subject || d.docId || 'Meeting',
        link: '/committee',
      })),
    write: async (action, native) => {
      const snap = await getDoc(dref('consultations', action.docId))
      if (!snap.exists()) throw new Error('Meeting not found')
      const actions = (snap.data().actions || []).map((a, i) =>
        i === action.actionId ? { ...a, status: native } : a,
      )
      await updateDoc(dref('consultations', action.docId), { actions })
    },
  },
  {
    key: 'escalations',
    label: 'Escalation',
    tone: '#e11d48',
    collection: 'escalations',
    toNorm: (s) => (s === 'closed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'closed' : n),
    extract: (d) =>
      (d.capa || []).filter(Boolean).map((a) => ({
        actionId: a.id,
        title: a.description || 'Corrective action',
        owner: a.owner || '',
        due: a.dueDate || '',
        native: a.status || 'open',
        context: d.docId || d.title || 'Customer escalation',
        link: `/stakeholder/escalations/${d.id}`,
      })),
    write: async (action, native) => {
      const snap = await getDoc(dref('escalations', action.docId))
      if (!snap.exists()) throw new Error('Escalation not found')
      const capa = (snap.data().capa || []).map((a) =>
        a.id === action.actionId ? { ...a, status: native, closedAt: native === 'closed' ? nowISO() : null } : a,
      )
      await updateDoc(dref('escalations', action.docId), { capa })
    },
  },
  {
    key: 'legalIssues',
    label: 'Legal',
    tone: '#b45309',
    collection: 'legalIssues',
    toNorm: (s) => (s === 'closed' ? 'done' : s === 'in_progress' ? 'in_progress' : 'open'),
    toNative: (n) => (n === 'done' ? 'closed' : n),
    extract: (d) =>
      (d.capa || []).filter(Boolean).map((a) => ({
        actionId: a.id,
        title: a.description || 'Corrective action',
        owner: a.owner || '',
        due: a.dueDate || '',
        native: a.status || 'open',
        context: d.docId || d.title || 'Legal issue',
        link: `/stakeholder/legal/${d.id}`,
      })),
    write: async (action, native) => {
      const snap = await getDoc(dref('legalIssues', action.docId))
      if (!snap.exists()) throw new Error('Legal issue not found')
      const capa = (snap.data().capa || []).map((a) =>
        a.id === action.actionId ? { ...a, status: native, closedAt: native === 'closed' ? nowISO() : null } : a,
      )
      await updateDoc(dref('legalIssues', action.docId), { capa })
    },
  },

]

export const SOURCE_BY_KEY = Object.fromEntries(SOURCES.map((s) => [s.key, s]))

/**
 * Subscribe to every source collection and deliver one flat, normalized list of
 * action items. Returns an unsubscribe function.
 */
export function subscribeActions(cb) {
  const latest = {} // { [sourceKey]: docs[] }
  // Keyed by COLLECTION, not source key: two sources can read the same
  // collection, and the notice names collections. Start pending so a caller
  // that waits for every source to answer (the portal home) does not treat
  // silence as "no outstanding actions".
  const status = Object.fromEntries(
    [...new Set(SOURCES.map((s) => s.collection))].map((name) => [name, 'pending'])
  )
  const emit = () => {
    const rows = []
    for (const src of SOURCES) {
      for (const d of latest[src.key] || []) {
        for (const a of src.extract(d)) {
          if (a.actionId === undefined || a.actionId === null) continue
          const norm = src.toNorm(a.native)
          rows.push({
            key: `${src.key}:${d.id}:${a.actionId}`,
            source: src.key,
            sourceLabel: src.label,
            tone: src.tone,
            docId: d.id,
            // Scope carried from the owning record so actions can be rolled up
            // by region / entity / site (Objectives & Targets).
            region: d.region || d.taskDetails?.region || '',
            entity: d.entity || d.taskDetails?.entity || '',
            siteId: d.siteId || d.taskDetails?.siteId || '',
            actionId: a.actionId,
            title: a.title,
            owner: a.owner,
            due: a.due,
            native: a.native,
            norm,
            overdue: isOverdue(a.due, norm),
            context: a.context,
            link: a.link,
            // Sources that cannot repeat simply do not set it, so every action
            // has a count of at least one and nothing has to special-case it.
            repeat: Number(a.repeat) || 1,
            repeatSince: a.repeatSince || '',
          })
        }
      }
    }
    // Rows and the reason they may be short, together. An action list that is
    // quietly short is worse here than anywhere else in the app: the whole
    // point of the tracker is that nothing outstanding is missed, so a silent
    // truncation says "you are up to date" when you are not.
    cb({ rows, incomplete: incompleteReadNotice(status), status: { ...status } })
  }
  // Shared listeners: these collections are already watched by their own
  // modules, so the tracker adds no extra reads when they're mounted too.
  // Each source is opened against its OWN collection policy before `extract`
  // sees it. Several of these collections seal the very fields the tracker
  // reads — `capa[].description` and `capa[].owner` on incidents,
  // `actions[].owner` on illnesses and consultations — so without this the
  // tracker would list a page of base64 where the action titles should be.
  //
  // One opener per source, not one shared: they are independent listeners on
  // independent collections, and a single sequence guard across all of them
  // would let a fast source silently discard a slow source's batch.
  const openers = Object.fromEntries(SOURCES.map((src) => [
    src.key,
    openSnapshots(src.collection, (rows) => { latest[src.key] = rows; emit() }),
  ]))

  const unsubs = SOURCES.map((src) =>
    subscribeOrgCollection(src.collection, ({ rows, status: st }) => {
      status[src.collection] = st
      openers[src.key](rows)
    }),
  )
  return () => unsubs.forEach((u) => u())
}

/** Write a normalized status back into the originating source document. */
export async function updateActionStatus(action, normStatus) {
  const src = SOURCE_BY_KEY[action.source]
  if (!src) throw new Error(`Unknown source: ${action.source}`)
  await src.write(action, src.toNative(normStatus))
}
