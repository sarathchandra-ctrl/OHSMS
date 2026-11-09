// ─────────────────────────────────────────────────────────────────────────────
// Sam the Buddy — pure answer engine (no Firestore, unit-tested).
// Routes a question to ISO 45001 clauses / modules and composes an answer,
// interpolating live stats when provided.
// ─────────────────────────────────────────────────────────────────────────────
import { ISO_CLAUSES, CLAUSE_BY_NUMBER } from './iso45001'

/** Lines of live data per stat group. `stats` keys are optional — missing = omitted. */
function statLines(statKey, stats = {}) {
  const s = stats
  const has = (k) => typeof s[k] === 'number'
  const lines = []
  switch (statKey) {
    case 'incidents':
      if (has('incidents')) lines.push(`You have ${s.incidents} incident report(s)`)
      if (has('illnesses')) lines.push(`${s.illnesses} illness report(s)`)
      break
    case 'assessments':
      if (has('assessments')) lines.push(`${s.assessments} risk assessment(s) on record`)
      break
    case 'audits':
      if (has('auditFindings')) lines.push(`${s.auditFindings} audit report(s) with findings`)
      if (has('auditPlans')) lines.push(`${s.auditPlans} audit plan(s)`)
      break
    case 'inspections':
      if (has('inspectionRecords')) lines.push(`${s.inspectionRecords} inspection record(s)`)
      break
    case 'permits':
      if (has('permits')) lines.push(`${s.permits} work permit(s)`)
      break
    case 'consultations':
      if (has('consultations')) lines.push(`${s.consultations} committee meeting(s) recorded`)
      break
    case 'emergency':
      if (has('mockDrills')) lines.push(`${s.mockDrills} drill/emergency record(s)`)
      if (has('extinguishers')) lines.push(`${s.extinguishers} fire extinguisher(s) tracked`)
      if (has('erpContacts')) lines.push(`${s.erpContacts} FERP emergency contact(s)`)
      if (has('erpRescuePlans')) lines.push(`${s.erpRescuePlans} scenario rescue plan(s)`)
      break
    case 'training':
      if (has('trainingCourses')) lines.push(`${s.trainingCourses} course(s) in the catalogue`)
      if (has('trainingRecords')) lines.push(`${s.trainingRecords} training record(s)`)
      if (has('trainingAssignments')) lines.push(`${s.trainingAssignments} training assignment(s)`)
      break
    case 'users':
      if (has('users')) lines.push(`${s.users} employee(s) in the directory`)
      break
    case 'sites':
      if (has('sites')) lines.push(`${s.sites} site(s) registered`)
      break
    case 'documents':
      if (has('documents')) lines.push(`${s.documents} controlled document(s)`)
      break
    case 'loto':
      if (has('lotoProcedures')) lines.push(`${s.lotoProcedures} LOTO procedure(s)`)
      break
    default:
      break
  }
  return lines
}

/** Find clause numbers mentioned in the question (e.g. "8.2", "clause 6.1.2"). */
export function findClauseNumbers(text) {
  const out = []
  const re = /\b(\d{1,2}(?:\.\d(?:\.\d)?)?)\b/g
  let m
  while ((m = re.exec(text))) {
    if (CLAUSE_BY_NUMBER[m[1]]) out.push(m[1])
  }
  return [...new Set(out)]
}

/** Keyword → clause matches, best first. */
export function findByKeywords(text) {
  const q = text.toLowerCase()
  const scored = ISO_CLAUSES.map((c) => ({
    c,
    score: c.keywords.reduce((n, k) => (q.includes(k) ? n + (k.length > 5 ? 2 : 1) : n), 0),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.map((x) => x.c)
}

function clauseAnswer(c, stats) {
  const parts = [
    { type: 'text', text: `**Clause ${c.clause} — ${c.title}.** ${c.summary}` },
    { type: 'modules', label: 'In Cult Fit SMS this lives in:', modules: c.modules },
  ]
  const lines = c.stat ? statLines(c.stat, stats) : []
  if (lines.length) parts.push({ type: 'text', text: `📊 Live: ${lines.join(' · ')}.` })
  return parts
}

/** Full clause→module map (the "ISO map" command). */
export function isoMap() {
  return ISO_CLAUSES.map((c) => ({ clause: c.clause, title: c.title, modules: c.modules }))
}

/**
 * Answer a question. Returns an array of message parts:
 *  { type:'text', text } | { type:'modules', label, modules:[{label,path}] } | { type:'map' }
 */
export function answer(question, stats = {}) {
  const q = (question || '').trim()
  if (!q) return [{ type: 'text', text: 'Ask me about any ISO 45001 clause — try “clause 5.4” or “emergency drills”.' }]

  if (/\biso map\b|clause map|all clauses|full map|correlat/i.test(q)) {
    return [
      { type: 'text', text: 'Here’s how ISO 45001:2018 maps onto your Cult Fit SMS modules:' },
      { type: 'map' },
    ]
  }

  // Explicit clause number(s) win.
  const nums = findClauseNumbers(q)
  if (nums.length) {
    return nums.slice(0, 2).flatMap((n) => clauseAnswer(CLAUSE_BY_NUMBER[n], stats))
  }

  // Keyword routing.
  const matches = findByKeywords(q)
  if (matches.length) {
    const parts = clauseAnswer(matches[0], stats)
    if (matches.length > 1) {
      parts.push({
        type: 'text',
        text: `Related: ${matches.slice(1, 4).map((c) => `clause ${c.clause} (${c.title})`).join(' · ')}.`,
      })
    }
    return parts
  }

  // Fallback.
  return [
    {
      type: 'text',
      text:
        'I’m Sam — your ISO 45001 buddy! 🦺 Ask me things like:\n' +
        '• “What is clause 5.4?”\n' +
        '• “Who covers emergency preparedness?”\n' +
        '• “How many incidents do we have?”\n' +
        '• “ISO map” for the full clause → module table.',
    },
  ]
}
