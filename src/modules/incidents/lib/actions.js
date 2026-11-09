// ─────────────────────────────────────────────────────────────────────────────
// Cross-source action helpers. Incident CAPA actions and illness corrective
// actions share one shape and stay embedded in their parent doc. The Action
// Tracker + dashboard derive a flat list client-side from the loaded set.
//
// The pure functions (flattenActions / isActionOverdue / summarizeActions) have
// no Firestore dependency and are unit-tested. setActionStatus writes back into
// the parent array via the data layer.
// ─────────────────────────────────────────────────────────────────────────────
import { updateIncident } from './incidents'
import { updateIllness } from './illnesses'
import { AUDIT } from './audit'

/** YYYY-MM-DD for "today" (local), for overdue comparison. */
export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** An action is overdue when its due date has passed and it isn't closed. */
export function isActionOverdue(action, today = todayISO()) {
  if (!action || action.status === 'closed' || !action.dueDate) return false
  return action.dueDate < today
}

/**
 * Flatten every embedded action from the loaded incidents + illnesses into one
 * list, each annotated with a back-link to its parent record.
 */
export function flattenActions(incidents = [], illnesses = []) {
  const out = []
  for (const inc of incidents) {
    if (inc?.deletedAt) continue
    for (const a of inc.capa || []) {
      out.push({ ...a, source: 'incident', sourceId: inc.id, sourceRef: inc.refNo || inc.id })
    }
  }
  for (const ill of illnesses) {
    if (ill?.deletedAt) continue
    for (const a of ill.actions || []) {
      out.push({ ...a, source: 'illness', sourceId: ill.id, sourceRef: ill.refNo || ill.id })
    }
  }
  return out
}

/** Count actions by status (+ overdue) for the dashboard widget. */
export function summarizeActions(actions = [], today = todayISO()) {
  const s = { total: actions.length, open: 0, in_progress: 0, closed: 0, overdue: 0 }
  for (const a of actions) {
    if (a.status && s[a.status] !== undefined) s[a.status] += 1
    if (isActionOverdue(a, today)) s.overdue += 1
  }
  return s
}

/**
 * Update one embedded action's status, writing the whole parent array back.
 * `action` must carry { source, sourceId, id }.
 */
export async function setActionStatus(action, status, actor) {
  const closedAt = status === 'closed' ? new Date().toISOString() : null
  const patch = (arr = []) => arr.map((a) => (a.id === action.id ? { ...a, status, closedAt } : a))
  if (action.source === 'incident') {
    const { getIncident } = await import('./incidents')
    const inc = await getIncident(action.sourceId)
    if (!inc) throw new Error('Incident not found')
    await updateIncident(action.sourceId, { capa: patch(inc.capa) }, {
      actor, action: AUDIT.ACTION_UPDATE, summary: `Action "${action.description?.slice(0, 40) || ''}" → ${status}`,
    })
  } else {
    const { getIllness } = await import('./illnesses')
    const ill = await getIllness(action.sourceId)
    if (!ill) throw new Error('Illness not found')
    await updateIllness(action.sourceId, { actions: patch(ill.actions) }, {
      actor, action: AUDIT.ACTION_UPDATE, summary: `Action "${action.description?.slice(0, 40) || ''}" → ${status}`,
    })
  }
}
