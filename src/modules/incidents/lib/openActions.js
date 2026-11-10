// An incident or illness is not closed while its corrective actions are
// open. closeIncident set lifecycle 'closed' whatever the CAPA said, so an
// incident could be closed the day it was reported with every action still
// to do, and the action tracker then listed actions on a closed incident.
// stack/policy.mjs refuses the same move (actions-open).

/** Actions in a CAPA list that are not closed. */
export function openActions(list) {
  return (Array.isArray(list) ? list : []).filter((a) => a && (a.status || 'open') !== 'closed')
}

/** The message shown when closing is refused, or '' when it may close. */
export function closeBlocker(list, what = 'incident') {
  const n = openActions(list).length
  if (!n) return ''
  return `${n} corrective action${n === 1 ? ' is' : 's are'} still open. Close ${n === 1 ? 'it' : 'them'} before closing the ${what}.`
}
