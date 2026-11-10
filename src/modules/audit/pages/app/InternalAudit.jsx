import React, { useState, useEffect, useMemo } from 'react'
import toast from 'react-hot-toast'
import {
  AlertCircle, AlertTriangle, ArrowLeft, Calendar, CalendarDays, Check, CheckCheck, CheckCircle2,
  ChevronLeft, ChevronRight, ClipboardCheck, ClipboardList, Download, FileDown, FileSignature,
  FileText, Hourglass, Inbox, Info, Layers, List, ListChecks, Pencil, PieChart, Play, Plus, Printer,
  Reply, RotateCcw, Save, Search, Send, Target, Trash2, User, UserPen, UserRound, X,
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useOrgData } from '../../context/OrgDataContext'
import SiteScopePicker from '../../../../shared/org/SiteScopePicker'
import DepartmentSelect from '../../../../shared/org/DepartmentSelect'
import { Field } from '../../../../shared/ui'
import { safeHref } from '../../../../shared/safeUrl'
import { uid } from '../../../../shared/lib/id'
import { todayISO, addDaysISO, isOverdueDate } from '../../../../shared/lib/dates'
import {
  subscribeAuditPlans,
  subscribeAuditFindings,
  createAuditPlan,
  createAuditFinding,
  updateAuditFinding,
} from '../../services/auditModule'
import { sameCentreId } from '../../../../shared/org/centreId'
import { MAX_UPLOAD_BYTES, formatSize } from '../../../../shared/storage'
import { uploadAuditEvidence } from '../../lib/attachments'

/*
 * Internal Audit module — adapted from the original OHSMS portal's Audit.jsx
 * into this clone's light theme and Firebase setup. Six sub-modules behind a
 * hub: Scheduler, Auditor Workplace, Auditee Workplace, Reports, Dashboard,
 * Calendar. Data lives in organizations/{orgId}/auditPlans + auditFindings.
 */

// ---- shared helpers ---------------------------------------------------------
/** Resolve a site id or code to its name; falls back to the raw value. */
const siteNameOf = (sites = [], id) =>
  sites.find((s) => s.id === id || sameCentreId(s.code, id))?.name || id

const getTypeClass = (type) => {
  const t = type || ''
  if (t.includes('Major')) return 'bg-rose-50 text-rose-600 border border-rose-300'
  if (t.includes('Minor')) return 'bg-orange-50 text-orange-600 border border-orange-300'
  if (t.includes('OFI')) return 'bg-amber-50 text-amber-700 border border-amber-300'
  return 'bg-sky-50 text-sky-600 border border-sky-300'
}

const fld = 'input'
const lbl = 'label'
const panel = 'card'

// ============================================================================
// MODULE 1: AUDIT SCHEDULER
// ============================================================================
const AuditScheduler = ({ setView, session, sites, users, locations = [], siteInventory = [] }) => {
  const [teamSearch, setTeamSearch] = useState('')
  const [plan, setPlan] = useState({
    siteId: '',
    region: '',
    entity: '',
    centerCode: '',
    leadAuditor: '',
    team: [],
    standard: 'ISO 45001:2018',
    startDate: '',
    endDate: '',
    docId: '',
  })
  const [rows, setRows] = useState([
    { auditor: '', auditee: '', dept: '', area: '', aspect: '', date: '', time: '' },
  ])
  const myName = session.name

  // There was an effect here that invented plan.docId as arithmetic on the site
  // name and the row count — `1000 + (rows.length * 137 + siteId.length * 41) %
  // 9000`. Two plans for one site with the same number of rows produced the
  // same reference, and the row count was read outside the dependency array, so
  // adding rows after choosing the site left the number computed from the old
  // one. The suppressed exhaustive-deps warning was the bug, written down.
  //
  // None of it was ever stored: createAuditPlan sets docId from reserveDocId
  // AFTER spreading the payload, so the reserved reference always won. What the
  // screen showed was a number that existed nowhere — which is worse than
  // showing nothing, because somebody writes it down.

  const addRow = () =>
    setRows([...rows, { auditor: '', auditee: '', dept: '', area: '', aspect: '', date: '', time: '' }])
  const removeRow = (i) => setRows(rows.filter((_, idx) => idx !== i))
  // The ROW is replaced, not written into. [...rows] is a shallow copy, so
  // next[i] is still the object the previous state holds — and these rows are
  // seeded from a Firestore snapshot, which every other screen reading that
  // snapshot is holding too.
  const updateRow = (i, f, v) => setRows(rows.map((r, idx) => (idx === i ? { ...r, [f]: v } : r)))
  const toggleTeam = (name) =>
    setPlan((p) => ({
      ...p,
      team: p.team.includes(name) ? p.team.filter((t) => t !== name) : [...p.team, name],
    }))

  const handleSave = async () => {
    if (!plan.siteId || !plan.startDate || !plan.leadAuditor)
      return alert('Please fill in Site, Lead Auditor and Start Date.')
    try {
      await createAuditPlan({
        ...plan,
        matrix: rows,
        createdAt: new Date().toISOString(),
        createdBy: session.user,
        status: 'Planned',
      })
      alert('Audit Plan saved successfully!')
      setView('hub')
    } catch (e) {
      alert('Save failed: ' + e.message)
    }
  }

  // The scope picker stores the site's id; older data may hold its code. Match
  // either, and fall back to the stored value so nothing renders blank.
  const siteName = (id) => siteNameOf(sites, id)
  const filteredAuditors = useMemo(() => {
    if (!teamSearch) return users
    const q = teamSearch.toLowerCase()
    return users.filter(
      (u) => u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q),
    )
  }, [users, teamSearch])

  return (
    <div className="animate-fade-in">
      <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } }`}</style>
      <div className="mb-6 flex items-center justify-between print:hidden">
        <div>
          <h2 className="text-2xl font-extrabold text-ink-800">
            <Calendar size={20} className="inline mr-2 text-brand-500" /> Audit Scheduler
          </h2>
          <p className="text-sm text-ink-500">Plan and assign audits across the organization.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="rounded-xl bg-surface-100 px-5 py-2.5 text-sm font-bold text-ink-700 transition hover:bg-surface-200">
            <Printer size={16} className="inline mr-2" />Print Plan
          </button>
          <button onClick={handleSave} className="rounded-xl bg-brand-gradient px-5 py-2.5 text-sm font-bold text-white shadow-brand transition active:scale-95">
            <Save size={16} className="inline mr-2" />Save Plan
          </button>
        </div>
      </div>

      <div className="space-y-6 pb-10 print:hidden">
        {/* Section 1 */}
        <div className={`${panel} border-l-4 border-l-brand-500 p-7`}>
          <h3 className="mb-6 text-lg font-bold text-brand-600">Section 1: General Information</h3>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            <div className="space-y-4">
              <Field label="Target Site (Region · Entity · Site)" labelClassName={lbl}>
                <SiteScopePicker
                  module="audit"
                  cols={1}
                  sites={siteInventory}
                  value={plan}
                  onChange={(v) => setPlan({ ...plan, ...v })}
                />
              </Field>
              <Field label="Center / Point" labelClassName={lbl}>
                <input value={plan.centerCode} onChange={(e) => setPlan({ ...plan, centerCode: e.target.value })} className={fld} maxLength={500} placeholder="Optional" />
              </Field>
              <Field label="Standard" labelClassName={lbl}>
                <input value={plan.standard} onChange={(e) => setPlan({ ...plan, standard: e.target.value })} className={fld} maxLength={500} />
              </Field>
            </div>
            <div className="space-y-4">
              <Field label="Lead Auditor" labelClassName={lbl}>
                <select value={plan.leadAuditor} onChange={(e) => setPlan({ ...plan, leadAuditor: e.target.value })} className={fld}>
                  <option value="">Select...</option>
                  <option value={myName}>➡️ Assign to Me ({myName})</option>
                  {users.map((u) => <option key={u.id} value={u.name}>{u.name}{u.email ? ` (${u.email})` : ''}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Start Date" labelClassName={lbl}><input type="date" value={plan.startDate} onChange={(e) => setPlan({ ...plan, startDate: e.target.value })} className={`${fld} font-mono`} /></Field>
                <Field label="End Date" labelClassName={lbl}><input type="date" value={plan.endDate} onChange={(e) => setPlan({ ...plan, endDate: e.target.value })} className={`${fld} font-mono`} /></Field>
              </div>
              {/* No reference until there is one. It is reserved on save, from
                  the org-wide counter, so nothing here can predict it — and a
                  predicted one is a number somebody writes on a form. */}
              <div className="rounded-lg bg-surface-50 px-3 py-2 text-xs text-ink-500">
                Ref ID: <span className="font-semibold text-ink-600">assigned when this plan is saved</span>
              </div>
            </div>
            <div className="flex flex-col rounded-2xl border border-ink-100 bg-surface-50 p-5">
              {/* A heading, not a <label>: what follows is a search box and a list of
                  checkboxes, so there is no single control for it to name. */}
              <span className={lbl}>Audit Team Members</span>
              <div className="relative mb-3">
                <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input type="text" placeholder="Search name or email..." value={teamSearch} onChange={(e) => setTeamSearch(e.target.value)} className={`${fld} pl-9`} maxLength={500} />
              </div>
              <div className="max-h-[160px] flex-1 space-y-1.5 overflow-y-auto">
                {filteredAuditors.map((u) => (
                  <button type="button" key={u.id} onClick={() => toggleTeam(u.name)} aria-pressed={plan.team.includes(u.name)} className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-left transition ${plan.team.includes(u.name) ? 'border-brand-300 bg-brand-50' : 'border-transparent hover:bg-surface'}`}>
                    <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${plan.team.includes(u.name) ? 'border-brand-500 bg-brand-500 text-white' : 'border-surface-300 bg-surface'}`}>
                      {plan.team.includes(u.name) && <Check size={10} className="inline" />}
                    </div>
                    <div className="truncate">
                      <div className={`truncate text-xs font-bold ${plan.team.includes(u.name) ? 'text-brand-700' : 'text-ink-700'}`}>{u.name}</div>
                      <div className="truncate text-[9px] text-ink-400">{u.email || 'No email'}</div>
                    </div>
                  </button>
                ))}
                {filteredAuditors.length === 0 && <div className="py-4 text-center text-xs italic text-ink-400">No auditors found.</div>}
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: matrix */}
        <div className={`${panel} border-t-4 border-t-emerald-500 p-7`}>
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-lg font-bold text-emerald-600">Section 2: Audit Execution Matrix</h3>
            <button onClick={addRow} className="rounded-xl border border-ink-100 bg-surface-50 px-4 py-2 text-xs font-bold text-ink-700 transition hover:bg-surface-100">
              <Plus size={16} className="inline mr-2 text-emerald-500" />Add Row
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-ink-100">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead className="bg-surface-50 text-[10px] uppercase tracking-widest text-ink-500">
                <tr>
                  <th className="p-3">Auditor</th><th className="p-3">Auditee</th><th className="p-3">Department</th>
                  <th className="p-3">Area</th><th className="p-3">Aspect / Process</th><th className="p-3 w-36">Date</th>
                  <th className="p-3 w-28">Time</th><th className="p-3 w-10"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((row, i) => (
                  <tr key={i} className="hover:bg-surface-50">
                    <td className="p-2">
                      <select className={`${fld} text-xs`} value={row.auditor} onChange={(e) => updateRow(i, 'auditor', e.target.value)}>
                        <option value="">Select...</option>
                        <option value={myName}>➡️ Assign to Me</option>
                        {plan.leadAuditor && <option value={plan.leadAuditor}>{plan.leadAuditor} (Lead)</option>}
                        {plan.team.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td className="p-2">
                      <select className={`${fld} text-xs`} value={row.auditee} onChange={(e) => updateRow(i, 'auditee', e.target.value)}>
                        <option value="">Select...</option>
                        <option value={myName}>➡️ Assign to Me</option>
                        {users.map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
                      </select>
                    </td>
                    <td className="p-2"><DepartmentSelect className={`${fld} text-xs`} value={row.dept} onChange={(e) => updateRow(i, 'dept', e.target.value)} placeholder="Dept…" /></td>
                    <td className="p-2">
                      <input className={`${fld} text-xs`} list="audit-locations" placeholder="Area" value={row.area} onChange={(e) => updateRow(i, 'area', e.target.value)} maxLength={500} />
                      {i === 0 && <datalist id="audit-locations">{locations.map((l) => <option key={l} value={l}>{l}</option>)}</datalist>}
                    </td>
                    {/* The column header names the field but is not tied to it, and
                        a date input has no placeholder to fall back on — so these
                        read as three unlabelled boxes per row. The row number is
                        in each name because there are as many rows as the plan has
                        sessions. */}
                    <td className="p-2"><input className={`${fld} text-xs`} aria-label={`Scope or clause, row ${i + 1}`} placeholder="Scope / clause..." value={row.aspect} onChange={(e) => updateRow(i, 'aspect', e.target.value)} maxLength={500} /></td>
                    <td className="p-2"><input type="date" className={`${fld} text-xs font-mono`} aria-label={`Date, row ${i + 1}`} value={row.date} onChange={(e) => updateRow(i, 'date', e.target.value)} /></td>
                    <td className="p-2"><input type="time" className={`${fld} text-xs font-mono`} aria-label={`Time, row ${i + 1}`} value={row.time} onChange={(e) => updateRow(i, 'time', e.target.value)} /></td>
                    <td className="p-2 text-center"><button onClick={() => removeRow(i)} aria-label={`Remove schedule row ${i + 1}${row.aspect ? `: ${row.aspect}` : ''}`} className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-50 text-rose-500 transition hover:bg-rose-500 hover:text-white"><Trash2 size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Print plan */}
      <PrintPlan plan={plan} rows={rows} siteName={siteName(plan.siteId)} />
    </div>
  )
}

// ============================================================================
// MODULE 2: AUDITOR WORKPLACE
// ============================================================================
const AuditorWorkplace = ({ setView, session, isGlobalOwner, plans, findings, sites = [], users = [] }) => {
  const siteName = (id) => siteNameOf(sites, id)
  const [view, setWView] = useState('list')
  const [filters, setFilters] = useState({ date: '', auditor: '', auditee: '', id: '' })
  const [currentTask, setCurrentTask] = useState(null)
  const [findingRows, setFindingRows] = useState([])
  const [docId, setDocId] = useState('')
  const [criteria, setCriteria] = useState('')

  const myTasks = useMemo(() => {
    const findingsList = []
    findings.forEach((v) => {
      if (v.auditor === session.user || isGlobalOwner) {
        findingsList.push({ ...(v.taskDetails || {}), status: v.status, findingRecord: v, _key: `${v.taskDetails?.planId}_${v.taskDetails?.area}_${v.taskDetails?.auditee}` })
      }
    })
    const plannedList = []
    plans.forEach((plan) => {
      (plan.matrix || []).forEach((row) => {
        if (row.auditor === session.user || isGlobalOwner) {
          const key = `${plan.docId}_${row.area}_${row.auditee}`
          if (!findingsList.some((f) => f._key === key)) {
            plannedList.push({ auditor: row.auditor || '', auditee: row.auditee || '', dept: row.dept || '', area: row.area || '', date: row.date || '', time: row.time || '', aspect: row.aspect || '', planId: plan.docId || '', siteId: plan.siteId || '', leadAuditor: plan.leadAuditor || '', standard: plan.standard || '', scope: 'OH&S Management System', status: 'Planned', findingRecord: null, _key: key })
          }
        }
      })
    })
    return [...findingsList, ...plannedList]
  }, [plans, findings, session.user, isGlobalOwner])

  const filtered = useMemo(
    () =>
      myTasks.filter((t) => {
        const md = !filters.date || (t.date && t.date.includes(filters.date))
        const ma = !filters.auditor || t.auditor?.toLowerCase().includes(filters.auditor.toLowerCase())
        const me = !filters.auditee || t.auditee?.toLowerCase().includes(filters.auditee.toLowerCase())
        const mi = !filters.id || t.findingRecord?.docId?.toLowerCase().includes(filters.id.toLowerCase())
        return md && ma && me && mi
      }),
    [myTasks, filters],
  )

  // Was `AF-${10000 + Date.parse(...) % 90000}`, which wraps every ninety
  // seconds AND returns the same value for two rows added inside one
  // millisecond — the ordinary case, because adding rows is a button. These ids
  // are what actions/lib/sources.js matches a CAPA back to its finding on, so
  // two findings collapsing into one is a finding that stops being tracked.
  const genId = () => uid('AF')

  const openTask = (task) => {
    setCurrentTask(task)
    setCriteria(task.standard || '')
    if (task.status === 'Planned') {
      // Blank, not invented. The reference is reserved by createAuditFinding on
      // save, after the payload is spread, so anything set here was discarded —
      // while being printed on the report in the meantime.
      setDocId('')
      setFindingRows([{ id: genId(), type: 'Observation', desc: '', clause: '', evidence: '', fileName: '' }])
      setWView('perform')
    } else {
      setDocId(task.findingRecord.docId)
      setFindingRows(task.findingRecord?.findings || [])
      setCriteria(task.findingRecord?.taskDetails?.criteria || task.standard || '')
      setWView(task.status === 'Submitted for Verification' ? 'verify' : 'readOnly')
    }
  }

  const addRow = () => setFindingRows([...findingRows, { id: genId(), type: 'Observation', desc: '', clause: '', evidence: '', fileName: '' }])
  const removeRow = (i) => setFindingRows(findingRows.filter((_, idx) => idx !== i))
  // Same shape as updateRow above, and this is the one that hurt: openTask
  // seeds findingRows with the ACTUAL objects out of the subscribeAuditFindings
  // snapshot. Typing into a row therefore edited the shared cache in place, so
  // FindingsRegister, CapaRegister and the central Action Tracker were showing
  // text nobody had saved — with no re-render to reveal it, and no way to undo
  // it by abandoning the edit.
  const updateRow = (i, f, v) =>
    setFindingRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [f]: v } : r)))
  const handleFile = async (i, file) => {
    if (!file) return
    if (file.size > MAX_UPLOAD_BYTES) return toast.error(`That file is larger than ${formatSize(MAX_UPLOAD_BYTES)}.`)
    if (!file.type.match('^(image/.*|application/pdf)$')) return toast.error('Attach a PDF or an image.')
    let attachment
    try {
      attachment = await uploadAuditEvidence(file)
    } catch (err) {
      return toast.error(err.message || 'That file could not be uploaded. Try attaching it again.')
    }
    setFindingRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, evidence: attachment.url, evidencePath: attachment.path, fileName: file.name } : r)),
    )
  }

  const handleSave = async () => {
    if (findingRows.some((f) => !f.desc)) return alert('Please fill the description for every finding.')
    // Objective evidence is mandatory for every finding, regardless of type
    // (Observation, OFI, Minor NC, Major NC).
    if (findingRows.some((f) => !f.evidence)) return alert('Objective evidence is mandatory — attach a file for every finding (Observation, OFI, Minor NC and Major NC).')
    const cleanTask = { ...currentTask, criteria: criteria || '' }
    delete cleanTask.findingRecord
    const cleanFindings = findingRows.map((f) => {
      let days = 30
      if (f.type === 'Minor NC') days = 15
      if (f.type === 'Major NC') days = 7

      // `genId() + idx` was string concatenation, not an offset — "AF-12345"
      // and index 0 gave "AF-123450". Unreachable, because every row is created
      // with an id, but it is the kind of dead line somebody later copies.
      return { ...f, id: f.id || genId(), auditeeDueDate: addDaysISO(days) }
    })
    try {
      // The auditor and auditee by uid as well as by name: the server lets the
      // assigned auditee answer these findings, and it decides that from a uid
      // (a display name is something a person can change about themselves).
      const auditee = users.filter((u) => u.name && u.name === cleanTask.auditee)
      await createAuditFinding({
        docId: docId || '', taskDetails: cleanTask, findings: cleanFindings,
        status: 'Reported', auditDate: new Date().toISOString(), auditor: session.user, siteId: cleanTask.siteId || 'GEN',
        createdByUid: session.uid || null,
        auditeeUid: auditee.length === 1 ? auditee[0].id : null,
      })
      alert('Audit saved & sent to auditee.')
      setView('hub')
    } catch (e) { alert('Error saving: ' + e.message) }
  }

  // Verification used to be approve-only: a weak answer could not go back.
  // Returning sends it to Reported (the auditee's "Action Required"), with
  // the auditor's note shown to them.
  const [returnNote, setReturnNote] = useState('')
  const handleReturn = async () => {
    if (!currentTask.findingRecord) return
    if (!returnNote.trim()) return alert('Say what the auditee needs to change.')
    try {
      await updateAuditFinding(currentTask.findingRecord.docKey, {
        status: 'Reported',
        returnNote: returnNote.trim().slice(0, 2000),
        returnedAt: new Date().toISOString(),
      })
      alert('Returned to the auditee.')
      setReturnNote('')
      setView('hub')
    } catch (e) { alert('Error returning: ' + e.message) }
  }

  const handleVerifyClose = async () => {
    if (!currentTask.findingRecord) return
    try {
      await updateAuditFinding(currentTask.findingRecord.docKey, { status: 'Closed', closureDate: new Date().toISOString() })
      alert('Audit verified & closed!')
      setView('hub')
    } catch (e) { alert('Error closing: ' + e.message) }
  }

  const rec = currentTask?.findingRecord

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <div>
          <h2 className="text-2xl font-extrabold text-ink-800"><ClipboardList size={20} className="inline mr-2 text-emerald-500" /> Auditor Workplace</h2>
          <p className="text-sm text-ink-500">Execute your assigned audits and raise findings.</p>
        </div>
      </div>

      <div className="print:hidden">
        {view === 'list' && (
          <>
            <div className={`${panel} mb-6 flex flex-wrap items-center gap-3 p-4`}>
              <input type="date" className={`${fld} w-36`} value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} />
              <input type="text" placeholder="Auditor" className={`${fld} w-36`} value={filters.auditor} onChange={(e) => setFilters({ ...filters, auditor: e.target.value })} maxLength={500} />
              <input type="text" placeholder="Auditee" className={`${fld} w-36`} value={filters.auditee} onChange={(e) => setFilters({ ...filters, auditee: e.target.value })} maxLength={500} />
              <input type="text" placeholder="Doc ID" className={`${fld} w-28`} value={filters.id} onChange={(e) => setFilters({ ...filters, id: e.target.value })} maxLength={500} />
              <button onClick={() => setFilters({ date: '', auditor: '', auditee: '', id: '' })} className="rounded-lg bg-surface-100 px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink-600 hover:bg-surface-200"><RotateCcw size={14} className="inline mr-1" />Reset</button>
            </div>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.length === 0 ? (
                <div className="col-span-full rounded-3xl border-2 border-dashed border-ink-100 py-16 text-center text-lg italic text-ink-400">No audits assigned to you yet.</div>
              ) : (
                filtered.map((task, i) => {
                  const map = {
                    Planned: ['border-t-sky-500', 'bg-sky-50 text-sky-700', 'Needs Audit', Play],
                    Reported: ['border-t-rose-500', 'bg-rose-50 text-rose-700', 'Correction Pending', Hourglass],
                    'Submitted for Verification': ['border-t-orange-500', 'bg-orange-50 text-orange-700', 'Verify Now', CheckCheck],
                    Closed: ['border-t-emerald-500', 'bg-emerald-50 text-emerald-700', 'Closed', FileText],
                  }
                  const [brd, chip, label, Icon] = map[task.status] || map.Planned
                  return (
                    <button type="button" key={i} onClick={() => openTask(task)} className={`${panel} w-full cursor-pointer border-t-4 ${brd} p-6 text-left transition hover:-translate-y-1 hover:shadow-md`}>
                      <div className="mb-4 flex items-start justify-between">
                        <span className={`rounded px-2 py-1 text-[9px] font-bold uppercase tracking-widest ${chip}`}>{label}</span>
                        <span className="rounded border border-ink-100 bg-surface-50 px-2 py-1 text-[10px] font-bold text-ink-500"><Calendar size={12} className="inline mr-1" />{task.date || '—'}</span>
                      </div>
                      <h3 className="mb-1 truncate text-lg font-bold text-ink-800">{task.dept} - {task.area}</h3>
                      <p className="mb-5 truncate text-xs text-ink-400"><Target size={14} className="inline mr-1.5" />{task.aspect}</p>
                      <div className="space-y-2 rounded-xl border border-ink-100 bg-surface-50 p-3 text-[11px] text-ink-600">
                        <div className="flex justify-between"><span>Site:</span><span className="font-bold text-ink-800">{siteName(task.siteId)}</span></div>
                        <div className="flex justify-between"><span>Auditor:</span><span className="font-bold text-emerald-600">{task.auditor}</span></div>
                        <div className="flex justify-between"><span>Auditee:</span><span className="font-bold text-amber-600">{task.auditee}</span></div>
                      </div>
                      <div className="mt-4 border-t border-ink-100 pt-3 text-center text-[10px] font-bold uppercase tracking-widest text-ink-500">
                        <Icon size={12} className="inline mr-2" />{label}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </>
        )}

        {view === 'perform' && currentTask && (
          <div className="mx-auto max-w-5xl animate-fade-in">
            <div className="mb-6 flex items-center justify-between">
              <button onClick={() => setWView('list')} className="text-sm font-bold text-ink-500 hover:text-ink-800"><ArrowLeft size={16} className="inline mr-2" />Back to Audit List</button>
              <button onClick={handleSave} className="rounded-xl bg-emerald-600 px-8 py-3 text-sm font-bold text-white shadow-lg transition active:scale-95 hover:bg-emerald-500"><Send size={16} className="inline mr-2" />Save & Send to Auditee</button>
            </div>
            <div className={`${panel} mb-8 p-7`}>
              <h3 className="mb-6 border-b border-ink-100 pb-3 text-xs font-bold uppercase tracking-widest text-emerald-600"><Info size={14} className="inline mr-2" />Section 1: Audit Context</h3>
              <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
                {[['Site', siteName(currentTask.siteId)], ['Auditor', currentTask.auditor], ['Auditee', currentTask.auditee], ['Date', currentTask.date]].map(([k, v]) => (
                  <div key={k}><label className={lbl}>{k}</label><div className="rounded-lg border border-ink-100 bg-surface-50 p-2.5 text-sm font-bold text-ink-800">{v || '—'}</div></div>
                ))}
                <Field label="Standard / Criteria Applied" labelClassName={lbl} className="col-span-2 md:col-span-4"><input value={criteria} onChange={(e) => setCriteria(e.target.value)} className={fld} maxLength={500} placeholder="e.g. ISO 45001:2018 Clause 8.1..." /></Field>
              </div>
            </div>
            <div className={`${panel} p-7`}>
              <div className="mb-6 flex items-center justify-between border-b border-ink-100 pb-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-brand-600"><ListChecks size={14} className="inline mr-2" />Section 2: Audit Findings Register</h3>
                <button onClick={addRow} className="rounded-xl bg-brand-gradient px-5 py-2 text-xs font-bold text-white shadow-brand transition active:scale-95"><Plus size={14} className="inline mr-2" />Log New Finding</button>
              </div>
              <div className="space-y-6">
                {findingRows.map((f, i) => (
                  <div key={i} className="relative rounded-2xl border border-ink-100 bg-surface-50 p-6">
                    <div className="absolute right-4 top-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-[10px] font-bold text-emerald-600">{f.id}</div>
                    <div className="mt-2 grid grid-cols-12 gap-6">
                      <Field label="Finding Type" labelClassName={lbl} className="col-span-12 md:col-span-3">
                        <select value={f.type} onChange={(e) => updateRow(i, 'type', e.target.value)} className={`w-full rounded-xl p-3 text-xs font-bold ${getTypeClass(f.type)}`}>
                          <option value="Observation">Observation</option>
                          <option value="OFI">Opp. for Improv. (OFI)</option>
                          <option value="Minor NC">Minor Non-Conformance</option>
                          <option value="Major NC">Major Non-Conformance</option>
                        </select>
                      </Field>
                      <Field label="Ref Clause" labelClassName={lbl} className="col-span-12 md:col-span-3"><input value={f.clause} onChange={(e) => updateRow(i, 'clause', e.target.value)} className={fld} maxLength={500} placeholder="e.g. 9.1.2" /></Field>
                      <div className="col-span-12 md:col-span-6">
                        <label className={lbl} htmlFor={`finding-evidence-${i}`}>Objective Evidence <span className="text-rose-500">*</span></label>
                        <input id={`finding-evidence-${i}`} type="file" accept="application/pdf,image/*" onChange={(e) => handleFile(i, e.target.files[0])} className="w-full text-[10px] text-ink-500 file:mr-3 file:rounded-lg file:border-none file:bg-surface-200 file:px-4 file:py-1.5 file:font-bold file:text-ink-600" />
                        {f.fileName ? (
                          <div className="mt-2 truncate text-[10px] font-bold text-emerald-600"><CheckCircle2 size={12} className="inline mr-1" />Attached: {f.fileName}</div>
                        ) : (
                          <div className="mt-2 text-[10px] font-bold text-rose-500"><AlertCircle size={12} className="inline mr-1" />Required — attach objective evidence for this finding.</div>
                        )}
                      </div>
                      <Field label="Detailed Description of Finding" labelClassName={lbl} className="col-span-12"><textarea value={f.desc} onChange={(e) => updateRow(i, 'desc', e.target.value)} rows="3" className={fld} maxLength={2000} placeholder="Describe the specific observation or non-conformance..." /></Field>
                    </div>
                    <button onClick={() => removeRow(i)} className="absolute bottom-4 right-4 flex h-9 w-9 items-center justify-center rounded-xl border border-ink-100 bg-surface text-ink-400 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={16} /></button>
                  </div>
                ))}
                {findingRows.length === 0 && <div className="rounded-3xl border-2 border-dashed border-ink-100 p-12 text-center italic text-ink-400">No findings logged. The audit is completely clean!</div>}
              </div>
            </div>
          </div>
        )}

        {(view === 'readOnly' || view === 'verify') && rec && (
          <div className="mx-auto max-w-5xl animate-fade-in">
            <div className="mb-6 flex items-center justify-between">
              <button onClick={() => setWView('list')} className="text-sm font-bold text-ink-500 hover:text-ink-800"><ArrowLeft size={16} className="inline mr-2" />Back to Audit List</button>
              <div className="flex gap-3">
                <button onClick={() => window.print()} className="rounded-xl bg-surface-100 px-5 py-2.5 text-sm font-bold text-ink-700 hover:bg-surface-200"><Printer size={16} className="inline mr-2" />Print Report</button>
                {view === 'verify' && <button onClick={handleReturn} className="rounded-xl bg-surface-100 px-5 py-2.5 text-sm font-bold text-ink-700 hover:bg-surface-200">Return to auditee</button>}
                {view === 'verify' && <button onClick={handleVerifyClose} className="rounded-xl bg-orange-600 px-6 py-2.5 text-sm font-bold text-white shadow-lg transition active:scale-95 hover:bg-orange-500"><CheckCheck size={16} className="inline mr-2" />Verify & Close Audit</button>}
              </div>
            </div>
            {view === 'verify' && (
              <div className="mb-4">
                <label htmlFor="audit-return-note" className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-500">Note for the auditee, if returning</label>
                <textarea id="audit-return-note" className="input min-h-[72px] w-full" value={returnNote} onChange={(e) => setReturnNote(e.target.value)} placeholder="What needs to change before this can be closed" />
              </div>
            )}
            <div className={`${panel} p-7`}>
              <div className="mb-8 flex items-start justify-between border-b border-ink-100 pb-6">
                <div>
                  <h2 className="mb-2 text-2xl font-extrabold text-ink-800">Audit Report Details</h2>
                  <p className="inline-block rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-sm font-bold text-emerald-600">Ref: {rec.docId}</p>
                </div>
                <span className={`text-sm font-bold uppercase ${rec.status === 'Closed' ? 'text-emerald-600' : rec.status === 'Submitted for Verification' ? 'text-orange-600' : 'text-rose-600'}`}>{rec.status}</span>
              </div>
              <FindingList findings={rec.findings} />
            </div>
          </div>
        )}
      </div>

      <PrintReport data={rec || {}} fallbackFindings={findingRows} currentTask={currentTask} docId={docId} siteName={siteName(currentTask?.siteId)} />
    </div>
  )
}

// ============================================================================
// MODULE 3: AUDITEE WORKPLACE
// ============================================================================
const AuditeeWorkplace = ({ session, users, findings }) => {
  const [selected, setSelected] = useState(null)
  const [modal, setModal] = useState(false)
  const [current, setCurrent] = useState(null)
  const [form, setForm] = useState({ rootCause: '', correction: '', capa: '', owner: '', targetDate: '', evidenceFile: null, evidenceFileName: '' })
  const myName = session.name

  const myAudits = useMemo(
    () => findings.filter((f) => f.taskDetails?.auditee === session.user),
    [findings, session.user],
  )

  // keep the selected record fresh as live data updates
  useEffect(() => {
    if (selected) {
      const fresh = myAudits.find((a) => a.docKey === selected.docKey)
      if (fresh && fresh !== selected) setSelected(fresh)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myAudits])

  const openResp = (f) => {
    setCurrent(f)
    setForm({
      rootCause: f.response?.rootCause || '', correction: f.response?.correction || '', capa: f.response?.capa || '',
      owner: f.response?.owner || '', targetDate: f.response?.targetDate || f.auditeeDueDate || todayISO(),
      evidenceFile: f.response?.evidenceFile || null, evidenceFileName: f.response?.evidenceFileName || '', evidenceFilePath: f.response?.evidenceFilePath || '',
    })
    setModal(true)
  }

  const handleFile = async (e) => {
    const file = e.target.files[0]
    if (file) {
      if (file.size > MAX_UPLOAD_BYTES) return alert(`File size exceeds ${formatSize(MAX_UPLOAD_BYTES)} limit.`)
      if (!file.type.match('^(image/.*|application/pdf)$')) return alert('Only PDF and image files are allowed.')
      try {
        const attachment = await uploadAuditEvidence(file)
        setForm((prev) => ({ ...prev, evidenceFile: attachment.url, evidenceFilePath: attachment.path, evidenceFileName: file.name }))
      } catch (err) {
        toast.error(err.message || 'That file could not be uploaded. Try attaching it again.')
      }
    }
  }

  const saveResponse = () => {
    if (!form.rootCause || !form.correction || !form.capa || !form.owner || !form.targetDate)
      return alert('Please fill all required fields, including CAPA Owner and Date.')
    const updated = (selected.findings || []).map((f) => (f.id === current.id ? { ...f, response: { ...form, status: 'Completed', capaStatus: 'Open' } } : f))
    setSelected({ ...selected, findings: updated })
    setModal(false)
  }

  const submit = async () => {
    const allDone = (selected.findings || []).every((f) => f.response?.status === 'Completed')
    if (!allDone) return alert('Please provide a response for ALL findings before submitting.')
    const updated = { ...selected, status: 'Submitted for Verification', submissionDate: new Date().toISOString() }
    try {
      await updateAuditFinding(selected.docKey, { findings: updated.findings, status: updated.status, submissionDate: updated.submissionDate })
      alert('Audit response submitted successfully!')
      setSelected(updated)
    } catch (e) { alert('Submission failed: ' + e.message) }
  }

  const editable = selected && selected.status === 'Reported'

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold text-ink-800"><UserPen size={20} className="inline mr-2 text-amber-500" /> Auditee Workplace</h2>
          <p className="text-sm text-ink-500">Respond to findings and submit corrective actions.</p>
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* inbox */}
        <div className={`${panel} flex w-full flex-col overflow-hidden lg:w-1/3`}>
          <div className="border-b border-ink-100 bg-surface-50 p-5">
            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-ink-800"><Inbox size={14} className="text-amber-500" /> Action Inbox <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">{myAudits.length}</span></h3>
          </div>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto p-4">
            {myAudits.length === 0 && <div className="mx-2 mt-6 rounded-2xl border-2 border-dashed border-ink-100 p-6 text-center text-sm italic text-ink-400">No audits in your inbox.</div>}
            {myAudits.map((a) => {
              const tone = a.status === 'Reported' ? 'border-l-rose-500' : a.status === 'Submitted for Verification' ? 'border-l-orange-500' : 'border-l-emerald-500'
              const label = a.status === 'Reported' ? 'Action Required' : a.status === 'Submitted for Verification' ? 'Pending Approval' : 'Closed'
              return (
                <button type="button" key={a.docKey} onClick={() => setSelected(a)} className={`w-full cursor-pointer rounded-2xl border border-l-4 border-ink-100 ${tone} p-5 text-left transition hover:bg-surface-50 ${selected?.docKey === a.docKey ? 'ring-2 ring-amber-300' : ''}`}>
                  <div className="mb-3 flex items-start justify-between">
                    <span className="rounded border border-ink-100 bg-surface-50 px-2 py-1 font-mono text-[10px] font-bold text-ink-600">{a.docId}</span>
                    <span className="rounded bg-surface-100 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-ink-600">{label}</span>
                  </div>
                  <h3 className="mb-1 truncate text-base font-bold text-ink-800">{a.taskDetails?.dept} - {a.taskDetails?.area}</h3>
                  <div className="mt-3 flex justify-between border-t border-ink-100 pt-3 text-xs text-ink-400">
                    <span><List size={16} className="inline mr-1.5 text-brand-500" />{a.findings?.length || 0} Findings</span>
                    <span className="font-mono">{(a.auditDate || '').split('T')[0]}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* details */}
        <div className={`${panel} flex w-full flex-col overflow-hidden lg:w-2/3`}>
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center p-16 text-center text-ink-400">
              <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-surface-100 text-3xl text-amber-500"><FileSignature size={24} /></div>
              <p className="mb-1 text-lg font-bold text-ink-800">No Audit Selected</p>
              <p className="text-sm">Select an assignment from your inbox to respond.</p>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="border-b border-ink-100 bg-surface-50 p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="mb-1 text-2xl font-extrabold text-ink-800">Audit Findings</h2>
                    <p className="inline-block rounded-lg border border-amber-200 bg-amber-50 px-3 py-1 font-mono text-sm font-bold text-amber-600">Ref: {selected.docId}</p>
                  </div>
                  <div className="text-right text-xs text-ink-500"><div className="font-bold text-ink-800"><UserRound size={16} className="inline mr-1 text-brand-500" />{selected.auditor}</div><div className="font-mono">{(selected.auditDate || '').split('T')[0]}</div></div>
                </div>
              </div>
              <div className="max-h-[55vh] flex-1 space-y-6 overflow-y-auto p-6">
                {selected.status === 'Reported' && selected.returnNote && (
                  <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
                    <p className="font-bold">Returned by the auditor</p>
                    <p className="mt-1 whitespace-pre-wrap">{selected.returnNote}</p>
                  </div>
                )}
                {(selected.findings || []).map((f, i) => {
                  const has = f.response?.status === 'Completed'
                  const overdue = !has && isOverdueDate(f.auditeeDueDate)
                  return (
                    <div key={i} className={`rounded-2xl border bg-surface p-6 ${has ? 'border-emerald-300' : 'border-ink-100'}`}>
                      <div className="mb-4 flex items-start justify-between border-b border-ink-100 pb-4">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1 font-mono text-xs font-bold text-rose-600">{f.id}</span>
                          <span className={`rounded-lg px-3 py-1 text-[10px] font-bold uppercase tracking-widest ${getTypeClass(f.type)}`}>{f.type}</span>
                          {f.auditeeDueDate && !has && <span className={`rounded-lg border px-3 py-1 text-[10px] font-bold uppercase ${overdue ? 'border-rose-300 bg-rose-50 text-rose-600' : 'border-orange-200 bg-orange-50 text-orange-600'}`}>Due: {f.auditeeDueDate}{overdue && ' !'}</span>}
                        </div>
                        {editable && <button onClick={() => openResp(f)} className={`rounded-xl px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white transition active:scale-95 ${has ? 'bg-surface-200 hover:bg-surface-300 text-ink-900' : 'bg-gradient-to-r from-amber-500 to-orange-500'}`}>{has ? <><Pencil size={16} className="inline mr-1" />Edit Reply</> : <><Reply size={16} className="inline mr-1" />Respond Now</>}</button>}
                      </div>
                      <div className="mb-2 rounded-r-lg border-l-4 border-surface-300 bg-surface-50 py-1 pl-4 text-sm text-ink-700">“{f.desc}”</div>
                      {has && <CapaSummary r={f.response} />}
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-end border-t border-ink-100 bg-surface-50 p-5">
                {editable ? (
                  <button onClick={submit} disabled={!(selected.findings || []).every((f) => f.response?.status === 'Completed')} className="rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 px-10 py-3 text-sm font-bold uppercase tracking-widest text-white shadow-lg transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"><Send size={16} className="inline mr-2" />Submit Responses to Auditor</button>
                ) : (
                  <span className={`rounded-xl border px-6 py-3 text-sm font-bold uppercase tracking-widest ${selected.status === 'Closed' ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-orange-200 bg-orange-50 text-orange-600'}`}>Status: {selected.status}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* response modal */}
      {modal && current && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
          <div className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink-100 p-6">
              <div>
                <h2 className="flex items-center gap-3 text-xl font-extrabold text-amber-600"><Reply size={18} /> Submit Corrective Action</h2>
                <p className="mt-1 font-mono text-xs text-ink-400">Finding ID: <span className="font-bold text-ink-800">{current.id}</span></p>
              </div>
              <button onClick={() => setModal(false)} className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-100 text-ink-500 hover:bg-surface-200"><X size={20} /></button>
            </div>
            <div className="flex-1 space-y-5 overflow-y-auto p-6">
              <div className="rounded-xl border border-ink-100 bg-surface-50 p-4">
                <span className={lbl}>Auditor’s Finding</span>
                <p className="border-l-4 border-amber-300 py-1 pl-4 text-sm text-ink-700">“{current.desc}”</p>
              </div>
              <Field label="1. Root Cause Analysis" labelClassName={lbl}><textarea rows="3" className={fld} value={form.rootCause} onChange={(e) => setForm({ ...form, rootCause: e.target.value })} maxLength={2000} placeholder="Why did this happen?" /></Field>
              <Field label="2. Immediate Correction" labelClassName={lbl}><input className={fld} value={form.correction} onChange={(e) => setForm({ ...form, correction: e.target.value })} maxLength={500} placeholder="What was done immediately?" /></Field>
              <Field label="3. Corrective / Preventive Action (CAPA)" labelClassName={lbl}><textarea rows="2" className={fld} value={form.capa} onChange={(e) => setForm({ ...form, capa: e.target.value })} maxLength={2000} placeholder="Long-term action to prevent recurrence" /></Field>
              <div className="grid grid-cols-2 gap-5">
                <div><label className={lbl} htmlFor="capa-owner">4. CAPA Owner</label>
                  <select id="capa-owner" className={fld} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
                    <option value="">Select Assignee...</option>
                    <option value={myName}>➡️ Assign to Me</option>
                    {users.map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
                  </select>
                </div>
                <Field label="5. Target Closure Date" labelClassName={lbl}><input type="date" className={`${fld} font-mono`} value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} /></Field>
              </div>
              <div><label className={lbl} htmlFor="capa-evidence">6. Objective Evidence (Optional)</label>
                <input id="capa-evidence" type="file" accept="application/pdf,image/*" onChange={handleFile} className="w-full text-xs text-ink-500 file:mr-3 file:rounded-lg file:border-none file:bg-brand-600 file:px-4 file:py-2 file:font-bold file:text-white" />
                {form.evidenceFileName && <span className="mt-2 inline-block text-[10px] font-bold text-emerald-600"><CheckCircle2 size={12} className="inline mr-1" />{form.evidenceFileName}</span>}
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-ink-100 p-5">
              <button onClick={() => setModal(false)} className="rounded-xl bg-surface-100 px-8 py-3 text-sm font-bold text-ink-700 hover:bg-surface-200">Cancel</button>
              <button onClick={saveResponse} className="rounded-xl bg-brand-600 px-10 py-3 text-sm font-bold text-white shadow-lg transition active:scale-95 hover:brightness-110"><Save size={16} className="inline mr-2" />Save Response</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// MODULE 4: AUDIT REPORTS
// ============================================================================
const AuditReports = ({ plans, findings, sites = [] }) => {
  const [tab, setTab] = useState('findings')
  const [filters, setFilters] = useState({ search: '', status: '', dept: '' })
  const [printData, setPrintData] = useState(null)
  const [printPlan, setPrintPlan] = useState(null)

  // sites here are remapped to { code: siteId, name }; resolve either form.
  const siteName = (id) => siteNameOf(sites, id)

  const reports = useMemo(() => [...findings].sort((a, b) => new Date(b.auditDate || 0) - new Date(a.auditDate || 0)), [findings])
  const planList = useMemo(() => [...plans].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)), [plans])

  const fReports = reports.filter((r) => {
    if (!r.taskDetails) return false
    const s = filters.search.toLowerCase()
    const ms = (r.docId || '').toLowerCase().includes(s) || (r.taskDetails.auditor || '').toLowerCase().includes(s) || (r.taskDetails.auditee || '').toLowerCase().includes(s)
    const mst = !filters.status || r.status === filters.status
    const md = !filters.dept || (r.taskDetails.dept || '').toLowerCase().includes(filters.dept.toLowerCase())
    return ms && mst && md
  })
  const fPlans = planList.filter((p) => {
    const s = filters.search.toLowerCase()
    return (p.docId || '').toLowerCase().includes(s) || (p.leadAuditor || '').toLowerCase().includes(s) || (p.siteId || '').toLowerCase().includes(s)
  })

  const statusColor = (s) => (s === 'Closed' ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : s === 'Submitted for Verification' ? 'bg-orange-50 text-orange-600 border-orange-200' : 'bg-rose-50 text-rose-600 border-rose-200')
  const doPrint = (r) => { setPrintPlan(null); setPrintData(r); setTimeout(() => window.print(), 100) }
  const doPrintPlan = (p) => { setPrintData(null); setPrintPlan(p); setTimeout(() => window.print(), 100) }

  return (
    <div className="animate-fade-in">
      <style>{`@media print { @page { size: A4 ${printPlan ? 'landscape' : 'portrait'}; margin: 10mm; } }`}</style>
      <div className="mb-6 flex items-center justify-between print:hidden">
        <div>
          <h2 className="text-2xl font-extrabold text-ink-800"><FileText size={20} className="inline mr-2 text-purple-500" /> Audit Reports & Schedules</h2>
          <p className="text-sm text-ink-500">Access and generate PDFs for all audits.</p>
        </div>
      </div>

      <div className="space-y-6 print:hidden">
        <div className="flex gap-3">
          <button onClick={() => setTab('findings')} className={`rounded-xl px-6 py-3 text-xs font-bold uppercase tracking-widest transition ${tab === 'findings' ? 'bg-purple-600 text-white shadow-lg' : 'bg-surface text-ink-500 border border-ink-100'}`}><Search size={14} className="inline mr-2" />Findings Reports</button>
          <button onClick={() => setTab('schedules')} className={`rounded-xl px-6 py-3 text-xs font-bold uppercase tracking-widest transition ${tab === 'schedules' ? 'bg-purple-600 text-white shadow-lg' : 'bg-surface text-ink-500 border border-ink-100'}`}><Calendar size={14} className="inline mr-2" />Master Schedules</button>
        </div>

        <div className={`${panel} flex flex-wrap items-center gap-4 p-5`}>
          <div className="relative min-w-[240px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-400" />
            <input placeholder="Search ID, Auditor, Site..." value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} className={`${fld} pl-11`} />
          </div>
          {tab === 'findings' && (
            <>
              <input placeholder="Filter Department" value={filters.dept} onChange={(e) => setFilters({ ...filters, dept: e.target.value })} className={`${fld} w-48`} />
              <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className={`${fld} w-52`}>
                <option value="">All Statuses</option><option value="Reported">Open / Reported</option><option value="Submitted for Verification">Verification Pending</option><option value="Closed">Closed</option>
              </select>
            </>
          )}
          <button onClick={() => setFilters({ search: '', status: '', dept: '' })} className="rounded-xl bg-surface-100 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-ink-600 hover:bg-surface-200"><RotateCcw size={14} className="inline mr-1" />Reset</button>
        </div>

        <div className={`${panel} overflow-x-auto`}>
          {tab === 'findings' ? (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-100 bg-surface-50 text-[10px] uppercase tracking-widest text-ink-500">
                <tr><th className="p-5">Report Ref</th><th className="p-5">Date</th><th className="p-5">Auditee / Dept</th><th className="p-5 text-center">Findings</th><th className="p-5 text-center">Status</th><th className="p-5 text-right">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {fReports.map((r, i) => (
                  <tr key={i} className="hover:bg-surface-50">
                    <td className="p-5 font-mono text-xs font-bold text-brand-600">{r.docId}</td>
                    <td className="p-5 font-mono text-xs text-ink-500">{(r.auditDate || '').split('T')[0]}</td>
                    <td className="p-5"><div className="font-bold text-ink-800">{r.taskDetails?.dept}</div><div className="text-[10px] uppercase tracking-widest text-ink-400"><User size={12} className="inline mr-1" />{r.taskDetails?.auditee}</div></td>
                    <td className="p-5 text-center"><span className="rounded-lg border border-ink-100 bg-surface-50 px-3 py-1.5 text-xs font-bold">{r.findings?.length || 0}</span></td>
                    <td className="p-5 text-center"><span className={`rounded-lg border px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest ${statusColor(r.status)}`}>{r.status === 'Submitted for Verification' ? 'Pending Verif.' : r.status}</span></td>
                    <td className="p-5 text-right"><button onClick={() => doPrint(r)} className="ml-auto flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white hover:bg-purple-500"><FileDown size={14} />Gen PDF</button></td>
                  </tr>
                ))}
                {fReports.length === 0 && <tr><td colSpan="6" className="p-16 text-center text-lg italic text-ink-400">No reports match your filters.</td></tr>}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-ink-100 bg-surface-50 text-[10px] uppercase tracking-widest text-ink-500">
                <tr><th className="p-5">Schedule Ref</th><th className="p-5">Target Site</th><th className="p-5">Standard</th><th className="p-5">Lead Auditor</th><th className="p-5">Range</th><th className="p-5 text-right">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {fPlans.map((p, i) => (
                  <tr key={i} className="hover:bg-surface-50">
                    <td className="p-5 font-mono text-xs font-bold text-brand-600">{p.docId}</td>
                    <td className="p-5 font-bold text-ink-800">{siteName(p.siteId)}</td>
                    <td className="p-5 font-bold text-purple-600">{p.standard}</td>
                    <td className="p-5">{p.leadAuditor}</td>
                    <td className="p-5 font-mono text-xs text-ink-500">{p.startDate} to {p.endDate}</td>
                    <td className="p-5 text-right"><button onClick={() => doPrintPlan(p)} className="ml-auto flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white hover:bg-purple-500"><FileDown size={14} />Gen PDF</button></td>
                  </tr>
                ))}
                {fPlans.length === 0 && <tr><td colSpan="6" className="p-16 text-center text-lg italic text-ink-400">No schedules match your filters.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {printData && <PrintReport data={printData} fallbackFindings={printData.findings} currentTask={printData.taskDetails} docId={printData.docId} siteName={siteName(printData?.taskDetails?.siteId)} />}
      {printPlan && <PrintPlan plan={printPlan} rows={printPlan.matrix || []} siteName={siteName(printPlan.siteId)} />}
    </div>
  )
}

// ============================================================================
// MODULE 5: AUDIT DASHBOARD
// ============================================================================
const AuditDashboard = ({ findings, sites = [] }) => {
  const siteName = (id) => siteNameOf(sites, id)
  const [selected, setSelected] = useState(null)
  const stats = useMemo(() => ({
    open: findings.filter((a) => a.status === 'Reported').length,
    inProgress: findings.filter((a) => a.status === 'Submitted for Verification').length,
    closed: findings.filter((a) => a.status === 'Closed').length,
    total: findings.length,
  }), [findings])

  const color = (s) => (s === 'Reported' ? 'text-rose-600 bg-rose-50 border-rose-200' : s === 'Submitted for Verification' ? 'text-orange-600 bg-orange-50 border-orange-200' : s === 'Closed' ? 'text-emerald-600 bg-emerald-50 border-emerald-200' : 'text-ink-500')
  const label = (s) => (s === 'Reported' ? 'Open Finding' : s === 'Submitted for Verification' ? 'Verif. Pending' : s)

  const cards = [
    ['Open Findings', stats.open, AlertTriangle, 'text-rose-600', 'bg-rose-100'],
    ['In Progress', stats.inProgress, Hourglass, 'text-orange-600', 'bg-orange-100'],
    ['Closed', stats.closed, CheckCircle2, 'text-emerald-600', 'bg-emerald-100'],
    ['Total Audits', stats.total, Layers, 'text-brand-600', 'bg-brand-100'],
  ]

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold text-ink-800"><PieChart size={20} className="inline mr-2 text-orange-500" /> Audit Dashboard</h2>
          <p className="text-sm text-ink-500">Real-time status of all organizational audits.</p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map(([l, v, Icon, txt, chipBg], i) => (
          <div key={l} style={{ animationDelay: `${i * 55}ms` }} className="card flex items-center gap-4 p-5">
            <span className={`icon-chip grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${chipBg} ${txt}`}>
              <Icon size={20} />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest text-ink-400">{l}</div>
              <div className={`text-3xl font-black ${txt}`}>{v}</div>
            </div>
          </div>
        ))}
      </div>

      <div className={`${panel} overflow-x-auto`}>
        <div className="flex items-center justify-between border-b border-ink-100 p-5">
          <h3 className="flex items-center gap-2 text-base font-bold text-ink-800"><List size={16} className="text-brand-500" /> Live Audit Records</h3>
          <span className="text-[10px] uppercase tracking-widest text-ink-400">Click row for details</span>
        </div>
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="bg-surface-50 text-[10px] uppercase tracking-widest text-ink-500">
            <tr><th className="p-5">Ref ID</th><th className="p-5">Status</th><th className="p-5">Date</th><th className="p-5">Department</th><th className="p-5">Auditor</th><th className="p-5">Auditee</th><th className="p-5 text-center">Findings</th></tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {findings.map((a, i) => (
              <tr key={i} onClick={() => setSelected(a)} className="cursor-pointer hover:bg-surface-50">
                <td className="p-5 font-mono text-xs font-bold text-brand-600">{a.docId}</td>
                <td className="p-5"><span className={`rounded-lg border px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest ${color(a.status)}`}>{label(a.status)}</span></td>
                <td className="p-5 font-mono text-xs text-ink-500">{(a.auditDate || '').split('T')[0]}</td>
                <td className="p-5 font-bold text-ink-800">{a.taskDetails?.dept}</td>
                <td className="p-5">{a.auditor}</td>
                <td className="p-5 italic text-ink-500">{a.taskDetails?.auditee}</td>
                <td className="p-5 text-center"><span className="rounded-lg border border-ink-100 bg-surface-50 px-3 py-1.5 text-xs font-bold">{a.findings?.length || 0}</span></td>
              </tr>
            ))}
            {findings.length === 0 && <tr><td colSpan="7" className="p-16 text-center text-lg italic text-ink-400">No audit records found.</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
          <div className="flex max-h-[95vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
            <div className="flex items-start justify-between border-b border-ink-100 bg-surface-50 p-6">
              <div><h2 className="mb-1 text-2xl font-extrabold text-ink-800">Audit Details</h2><p className="inline-block rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-sm font-bold text-emerald-600">Ref: {selected.docId}</p></div>
              <button onClick={() => setSelected(null)} className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-100 text-ink-500 hover:bg-surface-200"><X size={20} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mb-8 grid grid-cols-2 gap-5 rounded-2xl border border-ink-100 bg-surface-50 p-6 md:grid-cols-4">
                {[['Site', siteName(selected.taskDetails?.siteId)], ['Date', (selected.auditDate || '').split('T')[0]], ['Auditor', selected.auditor], ['Auditee', selected.taskDetails?.auditee], ['Department', selected.taskDetails?.dept], ['Area', selected.taskDetails?.area]].map(([k, v]) => (
                  <div key={k}><label className={lbl}>{k}</label><span className="text-sm font-bold text-ink-800">{v || '—'}</span></div>
                ))}
              </div>
              <FindingList findings={selected.findings} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// MODULE 6: AUDIT CALENDAR
// ============================================================================
const AuditCalendar = ({ sites, plans, findings }) => {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth())
  const [year, setYear] = useState(now.getFullYear())
  const [siteFilter, setSiteFilter] = useState('All')

  const events = useMemo(() => {
    const ev = []
    plans.forEach((plan) => {
      if (siteFilter !== 'All' && plan.siteId !== siteFilter) return
      ;(plan.matrix || []).forEach((m) => { if (m.date) ev.push({ date: m.date, type: 'scheduled', label: `Scheduled: ${m.dept}`, ref: plan.docId }) })
    })
    findings.forEach((f) => {
      if (siteFilter !== 'All' && f.taskDetails?.siteId !== siteFilter) return
      if (f.auditDate) ev.push({ date: f.auditDate.split('T')[0], type: 'assigned', label: 'Executed', ref: f.docId })
      if (f.submissionDate) ev.push({ date: f.submissionDate.split('T')[0], type: 'replied', label: 'Auditee Replied', ref: f.docId })
      if (f.closureDate) ev.push({ date: f.closureDate.split('T')[0], type: 'closed', label: 'Closed', ref: f.docId })
    })
    return ev
  }, [plans, findings, siteFilter])

  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const today = todayISO()

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-extrabold text-ink-800"><CalendarDays size={20} className="inline mr-2 text-indigo-500" /> Audit Calendar</h2>
          <p className="text-sm text-ink-500">Visual timeline of audit schedules and milestones.</p>
        </div>
      </div>

      <div className={`${panel} mb-5 flex flex-wrap items-center justify-between gap-4 p-5`}>
        <div className="flex items-center gap-3">
          <label className="text-xs font-bold uppercase tracking-widest text-ink-500" htmlFor="audit-site-view">Site View:</label>
          <select id="audit-site-view" className={`${fld} w-56`} value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="All">All Sites</option>
            {sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-ink-100 bg-surface-50 p-1.5">
          <button onClick={() => { if (month === 0) { setMonth(11); setYear((y) => y - 1) } else setMonth((m) => m - 1) }} className="rounded-lg px-4 py-2 text-ink-500 hover:bg-surface"><ChevronLeft size={16} className="inline" /></button>
          <span className="w-40 text-center text-sm font-bold text-ink-800">{months[month]} {year}</span>
          <button onClick={() => { if (month === 11) { setMonth(0); setYear((y) => y + 1) } else setMonth((m) => m + 1) }} className="rounded-lg px-4 py-2 text-ink-500 hover:bg-surface"><ChevronRight size={16} className="inline" /></button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap justify-center gap-6 rounded-2xl border border-ink-100 bg-surface p-4 text-[10px] font-bold uppercase tracking-widest text-ink-500">
        {[['bg-sky-500', 'Scheduled'], ['bg-orange-500', 'Assigned'], ['bg-yellow-400', 'Replied'], ['bg-emerald-500', 'Closed']].map(([c, l]) => (
          <span key={l} className="flex items-center"><span className={`mr-2 h-3 w-3 rounded-full ${c}`} /> {l}</span>
        ))}
      </div>

      <div className={`${panel} p-6`}>
        <div className="grid grid-cols-7 overflow-hidden rounded-xl border-l border-t border-ink-100">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="border-b border-r border-ink-100 bg-surface-50 p-3 text-center text-xs font-bold uppercase tracking-widest text-ink-500">{d}</div>
          ))}
          {(() => {
            const daysIn = new Date(year, month + 1, 0).getDate()
            const first = new Date(year, month, 1).getDay()
            const boxes = []
            for (let i = 0; i < first; i++) boxes.push(<div key={`e${i}`} className="min-h-[120px] border-b border-r border-ink-100 bg-surface-50/50" />)
            for (let d = 1; d <= daysIn; d++) {
              const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
              const dayEvents = events.filter((e) => e.date === ds)
              boxes.push(
                <div key={d} className="flex min-h-[120px] flex-col border-b border-r border-ink-100 bg-surface p-2">
                  <span className={`mb-2 block text-right text-sm font-bold ${today === ds ? 'text-indigo-600' : 'text-ink-400'}`}>{d}</span>
                  <div className="flex-1 space-y-1 overflow-y-auto">
                    {dayEvents.map((ev, i) => {
                      const tone = ev.type === 'scheduled' ? 'bg-sky-50 border-sky-200 text-sky-700' : ev.type === 'assigned' ? 'bg-orange-50 border-orange-200 text-orange-700' : ev.type === 'replied' ? 'bg-yellow-50 border-yellow-200 text-yellow-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      return <div key={i} title={`${ev.label} - ${ev.ref}`} className={`truncate rounded border p-1.5 text-[9px] font-bold leading-tight ${tone}`}><div className="uppercase">{ev.label}</div><div className="font-mono text-[8px] opacity-70">{ev.ref}</div></div>
                    })}
                  </div>
                </div>,
              )
            }
            return boxes
          })()}
        </div>
      </div>
    </div>
  )
}

// ---- small shared presentational pieces -------------------------------------
function CapaSummary({ r }) {
  return (
    <div className="mt-4 rounded-xl border-l-4 border-orange-400 bg-orange-50/50 p-5">
      <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-orange-600"><Reply size={14} /> Auditee Corrective Action Plan</div>
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-ink-100 bg-surface p-4"><span className={lbl}>Root Cause</span><span className="text-sm font-medium text-ink-800">{r.rootCause}</span></div>
        <div className="rounded-xl border border-ink-100 bg-surface p-4"><span className={lbl}>CAPA</span><span className="text-sm font-medium text-ink-800">{r.capa}</span></div>
      </div>
      <div className="flex items-center justify-between border-t border-orange-200 pt-3">
        {r.evidenceFileName ? <a href={safeHref(r.evidenceFile)} download={r.evidenceFileName} className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-600 hover:bg-emerald-600 hover:text-white"><Download size={14} />View Evidence</a> : <span className="text-xs italic text-ink-400">No Evidence Provided</span>}
        <div className="flex gap-6 text-right">
          <div><span className={lbl}>Owner</span><span className="text-xs font-bold text-ink-800">{r.owner}</span></div>
          <div><span className={lbl}>Target</span><span className="font-mono text-xs text-ink-800">{r.targetDate}</span></div>
        </div>
      </div>
    </div>
  )
}

function FindingList({ findings }) {
  return (
    <>
      <h3 className="mb-6 flex items-center gap-2 border-b border-ink-100 pb-2 text-xs font-bold uppercase tracking-widest text-brand-600"><ListChecks size={14} /> Documented Findings ({(findings || []).length})</h3>
      <div className="space-y-6">
        {(findings || []).map((f, i) => (
          <div key={i} className="rounded-2xl border border-ink-100 bg-surface-50 p-6">
            <div className="mb-4 flex items-center justify-between border-b border-ink-100 pb-3">
              <div className="flex items-center gap-3">
                <span className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 font-mono text-xs font-bold text-rose-600">{f.id}</span>
                <span className={`rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${getTypeClass(f.type)}`}>{f.type}</span>
              </div>
              <span className="rounded-lg border border-ink-100 bg-surface px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-ink-500">Clause: <span className="text-ink-800">{f.clause}</span></span>
            </div>
            <p className="mb-2 rounded-r-lg border-l-4 border-surface-300 bg-surface py-1 pl-4 text-sm text-ink-700">“{f.desc}”</p>
            {f.response?.status === 'Completed' ? <CapaSummary r={f.response} /> : <div className="rounded-xl border border-dashed border-ink-100 bg-surface p-4 text-center text-xs italic text-ink-400">No response submitted by auditee yet.</div>}
          </div>
        ))}
      </div>
    </>
  )
}

// ---- print layouts (black/white, used by window.print) ----------------------
function PrintReport({ data, fallbackFindings, currentTask, docId, siteName }) {
  const td = data?.taskDetails || currentTask || {}
  const list = data?.findings || fallbackFindings || []
  return (
    <div className="absolute inset-0 z-[9999] hidden min-h-screen doc-sheet p-10 print:block" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}>
      <div className="doc-header">
        <div>
          <p className="doc-kicker">Cult Fit SMS · ISO 45001 OHSMS</p>
          <h1 className="doc-title">Internal audit report</h1>
        </div>
        <div className="doc-meta">
          <div><b>Ref {data?.docId || docId}</b></div>
          <div className="mt-1">Date {(data?.auditDate || new Date().toISOString()).split('T')[0]}</div>
        </div>
      </div>
      <table className="doc-table mb-8">
        <tbody>
          <tr><td className="lbl">Site</td><td>{siteName || td.siteId}</td><td className="lbl">Standard</td><td>{td.standard}</td></tr>
          <tr><td className="lbl">Auditor</td><td>{td.auditor || data?.auditor}</td><td className="lbl">Lead auditor</td><td>{td.leadAuditor}</td></tr>
          <tr><td className="lbl">Auditee</td><td>{td.auditee}</td><td className="lbl">Dept / Area</td><td>{td.dept} / {td.area}</td></tr>
        </tbody>
      </table>
      <section className="doc-section">
        <h2 className="doc-section-title">1. Findings summary</h2>
        <table className="doc-table">
          <thead><tr><th>ID</th><th>Type</th><th>Clause</th><th>Description</th></tr></thead>
          <tbody>{list.map((f, i) => <tr key={i}><td className="text-center font-mono font-semibold">{f.id}</td><td className="text-center font-semibold">{f.type}</td><td className="text-center">{f.clause}</td><td>{f.desc}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="doc-section">
        <h2 className="doc-section-title">2. Corrective action report (CAR)</h2>
        {list.map((f, i) => (
          <div key={i} className="mb-6 rounded-lg ring-1 ring-ink-200 p-5">
            <div className="mb-3 flex justify-between border-b border-ink-200 pb-2"><span className="font-semibold">Finding {f.id}</span><span className="rounded-md bg-surface-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-ink-600 ring-1 ring-ink-200">{f.type}</span></div>
            <div className="doc-quote">“{f.desc}”</div>
            {f.response?.status === 'Completed' ? (
              <div className="doc-panel text-sm">
                <div className="mb-3"><strong>Root cause</strong><br />{f.response.rootCause}</div>
                <div className="mb-3"><strong>Immediate correction</strong><br />{f.response.correction}</div>
                <div className="mb-4"><strong>Corrective action (CAPA)</strong><br />{f.response.capa}</div>
                <div className="flex justify-between border-t border-ink-200 pt-3 text-xs"><div><strong>Owner:</strong> {f.response.owner}</div><div><strong>Target:</strong> {f.response.targetDate}</div><div><strong>Evidence:</strong> {f.response.evidenceFileName || 'None'}</div></div>
              </div>
            ) : <div className="text-sm font-semibold italic text-red-600">No corrective action submitted yet.</div>}
          </div>
        ))}
      </section>
      <table className="doc-sigs" role="presentation"><tbody><tr><td>Auditor signature</td><td className="gutter" aria-hidden="true" /><td>Auditee signature</td></tr></tbody></table>
    </div>
  )
}

function PrintPlan({ plan, rows, siteName }) {
  return (
    <div className="absolute inset-0 z-[9999] hidden min-h-screen doc-sheet p-10 print:block" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}>
      <div className="doc-header">
        <div>
          <p className="doc-kicker">Cult Fit SMS · ISO 45001 OHSMS</p>
          <h1 className="doc-title">Internal audit schedule &amp; matrix</h1>
        </div>
        <div className="doc-meta">
          <div><b>Ref {plan.docId || 'DRAFT'}</b></div>
          <div className="mt-1">Printed {new Date().toLocaleDateString()}</div>
        </div>
      </div>
      <div className="doc-panel mb-8">
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="border-b border-ink-200 p-2 font-semibold text-ink-500">Target site</td><td className="border-b border-ink-200 p-2 text-lg font-semibold">{siteName || plan.siteId || 'N/A'}</td><td className="border-b border-ink-200 p-2 font-semibold text-ink-500">Lead auditor</td><td className="border-b border-ink-200 p-2">{plan.leadAuditor || 'N/A'}</td></tr>
            <tr><td className="border-b border-ink-200 p-2 font-semibold text-ink-500">Standard</td><td className="border-b border-ink-200 p-2">{plan.standard}</td><td className="border-b border-ink-200 p-2 font-semibold text-ink-500">Date range</td><td className="border-b border-ink-200 p-2 font-mono">{plan.startDate} to {plan.endDate}</td></tr>
            <tr><td className="p-2 font-semibold text-ink-500">Audit team</td><td className="p-2" colSpan="3">{(plan.team || []).join(', ') || 'None assigned'}</td></tr>
          </tbody>
        </table>
      </div>
      <section className="doc-section">
        <h2 className="doc-section-title">Execution matrix</h2>
        <table className="doc-table text-xs">
          <thead><tr><th>Auditor</th><th>Auditee</th><th>Department</th><th>Area</th><th>Aspect</th><th>Date</th><th>Time</th></tr></thead>
          <tbody>{(rows || []).map((r, i) => <tr key={i}><td className="font-semibold">{r.auditor}</td><td className="font-semibold">{r.auditee}</td><td>{r.dept}</td><td>{r.area}</td><td>{r.aspect}</td><td className="text-center font-mono">{r.date}</td><td className="text-center font-mono">{r.time}</td></tr>)}</tbody>
        </table>
      </section>
      <table className="doc-sigs" role="presentation"><tbody><tr><td>Lead auditor signature</td><td className="gutter" aria-hidden="true" /><td>Management rep signature</td></tr></tbody></table>
    </div>
  )
}


// ============================================================================
// MASTER HUB
// ============================================================================
export default function InternalAudit() {
  const { profile, isAdmin } = useAuth()
  const { sites: rawSites, users: rawUsers, locations, siteInventory } = useOrgData()
  const [view, setView] = useState('hub')
  const [plans, setPlans] = useState([])
  const [findings, setFindings] = useState([])


  useEffect(() => {
    const unsubs = [
      subscribeAuditPlans(setPlans),
      subscribeAuditFindings(setFindings),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  // Let Sam's guided tour open a module tab (e.g. dispatch 'sam:view').
  useEffect(() => {
    const handler = (e) => setView(e.detail === 'home' ? 'hub' : e.detail)
    window.addEventListener('sam:view', handler)
    return () => window.removeEventListener('sam:view', handler)
  }, [])

  const session = useMemo(
    () => ({ uid: profile?.uid, user: profile?.name, name: profile?.name, email: profile?.email, role: profile?.role }),
    [profile],
  )
  const sites = useMemo(() => rawSites.map((s) => ({ code: s.id, name: s.name })), [rawSites])
  const users = useMemo(
    () => rawUsers.filter((u) => u.status === 'approved').map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status })),
    [rawUsers],
  )

  const shared = { setView, session, isGlobalOwner: isAdmin, sites, users, plans, findings, locations, siteInventory }

  const TILES = [
    ['scheduler', 'Scheduler', Calendar, 'text-sky-600', 'bg-sky-100', 'Plan annual audits & assign auditors'],
    ['auditor', 'Auditor Workplace', ClipboardList, 'text-emerald-600', 'bg-emerald-100', 'Execute audits & record findings'],
    ['auditee', 'Auditee Workplace', UserPen, 'text-amber-600', 'bg-amber-100', 'Submit corrections & evidence'],
    ['reports', 'Reports', FileText, 'text-purple-600', 'bg-purple-100', 'Verify closure & generate PDFs'],
    ['calendar', 'Calendar', CalendarDays, 'text-indigo-600', 'bg-indigo-100', 'Visual lifecycle timeline'],
    ['dashboard', 'Dashboard', PieChart, 'text-orange-600', 'bg-orange-100', 'Analytics & trends'],
  ]

  const moduleEl = {
    scheduler: <AuditScheduler {...shared} />,
    auditor: <AuditorWorkplace {...shared} />,
    auditee: <AuditeeWorkplace {...shared} />,
    reports: <AuditReports {...shared} />,
    calendar: <AuditCalendar {...shared} />,
    dashboard: <AuditDashboard {...shared} />,
  }[view]

  // A module is open — show it with a "back to hub" control.
  if (moduleEl) {
    return (
      <div className="animate-fade-in">
        <button
          onClick={() => setView('hub')}
          className="mb-4 inline-flex items-center gap-2 rounded-xl bg-surface-100 px-4 py-2 text-sm font-bold text-ink-600 transition hover:bg-surface-200 print:hidden"
        >
          <ArrowLeft size={16} /> Back to Hub
        </button>
        {moduleEl}
      </div>
    )
  }

  // Landing hub — six module tiles.
  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink-800"><ClipboardCheck size={20} className="inline mr-2 text-brand-500" /> Internal Audit Hub</h1>
        <p className="mt-1 text-sm text-ink-500">ISO 45001 audit lifecycle — plan, execute, correct, verify and report.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map(([key, title, Icon, color, chipBg, desc], i) => (
          <button
            key={key}
            data-tour={key}
            onClick={() => setView(key)}
            style={{ animationDelay: `${i * 55}ms` }}
            className="card flex items-center gap-4 p-4 text-left focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400/50"
          >
            <span className={`icon-chip grid h-14 w-14 shrink-0 place-items-center rounded-2xl ${chipBg} ${color}`}>
              <Icon size={24} />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-bold text-ink-800">{title}</span>
              <span className="block truncate text-xs text-ink-400">{desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
