import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactToPrint } from 'react-to-print'
import {
  Siren, Plus, Trash2, FileText, X, ShieldCheck, UserPlus, ListChecks, ImagePlus, Image as ImageIcon,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Badge, Spinner, Field } from '../components/ui'
import { Pager, IconButton } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { addMockDrill, deleteMockDrill, getMockDrillPhotos } from '../lib/firestore'
import { readFileAsDataUrl } from '../../../shared/lib/files'
import { orgDepartments } from '../../../shared/auth/access'
import MockDrillReport from '../components/MockDrillReport'

const MAX_DRILL_PHOTOS = 8
import {
  SCENARIOS, FIRE_SOURCE_OPTIONS, MEDICAL_INCIDENT_OPTIONS, EMERGENCY_TEAMS,
  getActiveChecklist, getScenario, DRILL_OUTCOMES, EVENT_TYPES, CAPA_STATUSES,
} from '../lib/mockDrillTemplates'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import DeptPersonPicker from '../../../shared/org/DeptPersonPicker'
import { subscribeContacts as subscribeErpContacts } from '../../emergency/lib/firestore'
import { safeSrc } from '../../../shared/safeUrl'
import IncompleteNotice from '../../../shared/ui/IncompleteNotice'
import { isFutureDate, todayISO } from '../../../shared/lib/dates'

const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const today = () => todayISO()

const freshForm = () => ({
  centerName: '', region: '', entity: '', siteId: '', eventType: 'Mock Drill',
  date: today(), time: nowTime(),
  fireSource: '', medicalIncidentType: '',
  evacTimeMin: '', ertResponseMin: '', headCount: '',
  debrief: '', outcome: 'Pass',
})

function scoreOf(checks, checklist) {
  const done = Object.values(checks).filter(Boolean).length
  return checklist.length ? Math.round((done / checklist.length) * 100) : 0
}

export default function MockDrills() {
  const { profile } = useAuth()
  const { mockDrills, sites, siteInventory, users, org, incomplete, loading } = useFleet()
  // Org-configured departments UNION those actually on people, same as the
  // shared DeptPersonPicker — otherwise back-filling a person's department
  // writes a value the select has no option for, which renders as empty.
  const departments = useMemo(
    () => [...new Set([...orgDepartments(org), ...users.map((u) => u.dept || u.department).filter(Boolean)])].sort(),
    [org, users]
  )

  const [siteFilter, setSiteFilter] = useState('all')
  const [scenario, setScenario] = useState(null) // open recorder when set
  const [viewing, setViewing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)

  // ── recorder form state ──
  const [form, setForm] = useState(freshForm())
  const [commanders, setCommanders] = useState([])
  const [commanderPick, setCommanderPick] = useState('')
  const [commanderManual, setCommanderManual] = useState('')
  const autoCmRef = useRef('') // CM auto-filled from the site's ERP contacts
  const [checks, setChecks] = useState({})
  const [teamChecks, setTeamChecks] = useState({})
  const [actionLog, setActionLog] = useState([{ time: '', action: '', observation: '' }])
  const [capa, setCapa] = useState([])
  const [photos, setPhotos] = useState([]) // recorder evidence photos: [{ id, dataUrl }]
  const [uploadingPhoto, setUploadingPhoto] = useState(false)

  // detail-modal + full-size photo viewing
  const [viewPhotos, setViewPhotos] = useState([])
  const [viewPhotosLoading, setViewPhotosLoading] = useState(false)
  const [enlarge, setEnlarge] = useState(null) // a data URL shown full-size

  const checklist = useMemo(
    () => (scenario ? getActiveChecklist(scenario.title, form.fireSource, form.medicalIncidentType) : []),
    [scenario, form.fireSource, form.medicalIncidentType]
  )
  const score = scoreOf(checks, checklist)

  // ── PDF printing ──
  const printRef = useRef(null)
  const [printRecord, setPrintRecord] = useState(null)
  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: printRecord ? `MockDrill-${printRecord.docId || printRecord.scenario}` : 'Mock-Drill-Report',
    pageStyle: `@page { size: A4; margin: 10mm; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`,
    onAfterPrint: () => setPrintRecord(null),
  })
  // Print once the off-screen report has rendered the chosen record.
  useEffect(() => {
    if (printRecord) handlePrint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printRecord])

  const history = useMemo(() => {
    if (siteFilter === 'all') return mockDrills
    return mockDrills.filter((d) => d.centerName === siteFilter)
  }, [mockDrills, siteFilter])

  // Pages the history table only. A PDF is always printed from one record
  // (`printRecord`), so the report is untouched by this.
  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(history)

  const openScenario = (s) => {
    setScenario(s)
    setForm(freshForm())
    setCommanders([]); setCommanderPick(''); setCommanderManual('')
    setChecks({}); setTeamChecks({})
    setActionLog([{ time: '', action: '', observation: '' }]); setCapa([])
    setPhotos([])
  }
  const closeRecorder = () => setScenario(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  // The site's CM from the Emergency Response Plan is the Incident Commander by
  // default — auto-filled when a site is picked, and freely editable afterwards.
  useEffect(() => {
    if ((!form.siteId)) return undefined
    return subscribeErpContacts((list) => {
      const cm = list.find(
        (c) => c.kind === 'internal' && c.siteId === form.siteId && (c.role || '').toUpperCase() === 'CM'
      ) || list.find(
        (c) => c.kind === 'internal' && !c.siteId && (c.role || '').toUpperCase() === 'CM'
      )
      const name = (cm?.name || '').trim()
      if (!name) return
      setCommanders((prev) => {
        // Only seed it — never overwrite what the user has already entered.
        if (prev.length > 0 || autoCmRef.current === name) return prev
        autoCmRef.current = name
        return [name]
      })
    })
  }, [form.siteId])

  // commanders
  const addCommander = (src) => {
    let name = ''
    if (src === 'db') { const u = users.find((x) => x.uid === commanderPick); name = (u?.name || u?.email || '').trim() }
    else name = commanderManual.trim()
    if (!name) return
    if (commanders.some((n) => n.toLowerCase() === name.toLowerCase())) { src === 'db' ? setCommanderPick('') : setCommanderManual(''); return }
    setCommanders([...commanders, name])
    src === 'db' ? setCommanderPick('') : setCommanderManual('')
  }
  const removeCommander = (i) => setCommanders(commanders.filter((_, idx) => idx !== i))

  // action log + capa
  const addRow = () => setActionLog([...actionLog, { time: '', action: '', observation: '' }])
  const setRow = (i, k, v) => setActionLog(actionLog.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
  const delRow = (i) => setActionLog(actionLog.filter((_, idx) => idx !== i))
  const addCapa = () => setCapa([...capa, { action: '', department: '', assignees: [], due: '', status: 'Open' }])
  const setCapaRow = (i, k, v) => setCapa(capa.map((c, idx) => (idx === i ? { ...c, [k]: v } : c)))
  const delCapa = (i) => setCapa(capa.filter((_, idx) => idx !== i))

  const submit = async () => {
    if (!form.centerName.trim()) return toast.error('Site is required')
    // A drill is a record of one that was RUN. Dating it ahead turns a plan
    // into evidence of a completed drill, which is the compliance figure this
    // module exists to report.
    if (isFutureDate(form.date)) return toast.error('The drill date cannot be in the future')
    if (commanders.length === 0) return toast.error('Add at least one incident commander')
    if (scenario.title === 'Fire Emergency' && !form.fireSource) return toast.error('Select the source of fire')
    if (scenario.title === 'Medical Emergency' && !form.medicalIncidentType) return toast.error('Select the medical incident type')

    setBusy(true)
    try {
      const record = {
        ...form,
        scenario: scenario.title,
        // docId is issued by the write path from the org-wide counter. It used
        // to be built here as MD-SITE-<random 5 digits>, which could collide
        // and sorted by nothing useful.
        commanders,
        commander: commanders.join(', '),
        evacTimeMin: form.evacTimeMin === '' ? null : Number(form.evacTimeMin),
        ertResponseMin: form.ertResponseMin === '' ? null : Number(form.ertResponseMin),
        headCount: form.headCount === '' ? null : Number(form.headCount),
        checklist,
        checklistStatus: checks,
        teamsAlerted: teamChecks,
        score,
        actionLog: actionLog.filter((l) => l.action && l.action.trim()),
        capa: capa.filter((c) => c.action && c.action.trim()).map((c) => ({
          ...c,
          // Derived display string so everything that reads .owner — the action
          // tracker, the printed report, exports — keeps working unchanged.
          owner: [c.department, (c.assignees || []).map((a) => a.name).join(', ')]
            .filter(Boolean).join(' — '),
        })),
        photos: photos.map((p) => p.dataUrl),
      }
      const saved = await addMockDrill(record, { uid: profile?.uid, name: profile?.name })
      // A drill saved with four of five photographs is still a success, and
      // still something the person who took them needs to hear about while they
      // are standing where they took them.
      const missed = (saved?.photosRequested || 0) - (saved?.photosSaved || 0)
      if (missed > 0) {
        toast.error(
          `${form.eventType} report saved, but ${missed} photo${missed === 1 ? '' : 's'} could not be attached. Add ${missed === 1 ? 'it' : 'them'} again from the record.`,
          { duration: 8000 },
        )
      } else {
        toast.success(`${form.eventType} report saved`)
      }
      setScenario(null)
    } catch (err) {
      toastCaught(err)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    try {
      await deleteMockDrill(removing.id, { uid: profile?.uid, name: profile?.name }, `${removing.scenario} @ ${removing.centerName}`)
      toast.success('Record deleted')
    } catch (err) { toastCaught(err) } finally { setRemoving(null) }
  }

  // recorder evidence photos
  const onDrillPhoto = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setUploadingPhoto(true)
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) { toast.error('Only image files are allowed'); continue }
        try {
          const dataUrl = await readFileAsDataUrl(file) // validates + caps at the shared upload limit
          let added = true
          setPhotos((p) => {
            if (p.length >= MAX_DRILL_PHOTOS) { added = false; return p }
            return [...p, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, dataUrl }]
          })
          if (!added) { toast.error(`Up to ${MAX_DRILL_PHOTOS} photos per record`); break }
        } catch (err) { toastCaught(err) }
      }
    } finally { setUploadingPhoto(false) }
  }
  const removeDrillPhoto = (id) => setPhotos((p) => p.filter((x) => x.id !== id))

  // open the detail modal, lazy-loading the drill's evidence photos
  const openView = async (d) => {
    setViewing(d); setViewPhotos([])
    if (d.photoCount > 0) {
      setViewPhotosLoading(true)
      try { setViewPhotos(await getMockDrillPhotos(d.id)) }
      catch { /* non-fatal */ }
      finally { setViewPhotosLoading(false) }
    }
  }

  // fetch photos (if any) then trigger the PDF print
  const downloadPdf = async (d) => {
    let photoUrls = []
    if (d.photoCount > 0) {
      try { photoUrls = (await getMockDrillPhotos(d.id)).map((p) => p.dataUrl) }
      catch { /* non-fatal — print without photos */ }
    }
    setPrintRecord({ ...d, photos: photoUrls })
  }

  const scoreColor = (s) => (s >= 100 ? '#16a34a' : s >= 70 ? '#f59e0b' : '#dc2626')

  return (
    <div>
      <PageHeader title="Mock Drills" subtitle="Site-wise emergency drills & response records" icon={Siren}>
        <select className="input w-auto" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="all">All sites</option>
          {sites.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </PageHeader>


      <IncompleteNotice incomplete={incomplete} className="mb-4" />
      {/* Scenario picker */}
      <div className="mb-8">
        <p className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">Initiate a scenario</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => openScenario(s)}
              className="card flex flex-col items-start gap-2 border-l-4 p-4 text-left transition hover:-translate-y-0.5"
              style={{ borderLeftColor: s.color }}
            >
              <span className="text-3xl">{s.emoji}</span>
              <span className="font-bold text-ink-900">{s.title}</span>
              <span className="text-xs text-ink-400">{s.checklist.length}-step protocol →</span>
            </button>
          ))}
        </div>
      </div>

      {/* History */}
      <p className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">Drill & emergency records</p>
      {loading ? (
        <div className="grid place-items-center py-16"><Spinner size={28} /></div>
      ) : history.length === 0 ? (
        <EmptyState icon={ListChecks} title="No records yet" hint="Pick a scenario above to run and record a mock drill." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-surface-200/60 text-[11px] uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Scenario</th>
                  <th className="px-4 py-2.5">Site</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Commander</th>
                  <th className="px-4 py-2.5">Score</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/50">
                {pageItems.map((d) => (
                  <tr key={d.id} className="hover:bg-surface-50">
                    <td className="px-4 py-2.5">
                      <Badge color={d.eventType === 'Real Emergency' ? '#dc2626' : '#3b82f6'}>{d.eventType || 'Mock Drill'}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <button className="inline-flex items-center gap-1.5 font-semibold text-ink-800 hover:text-brand-600" onClick={() => openView(d)}>
                        {getScenario(d.scenario)?.emoji} {d.scenario}
                        {d.photoCount > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-ink-400"><ImageIcon size={12} />{d.photoCount}</span>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-ink-500">{d.centerName || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-500">{d.date} {d.time}</td>
                    <td className="px-4 py-2.5 text-ink-600">{d.commander || '—'}</td>
                    <td className="px-4 py-2.5"><Badge color={scoreColor(d.score || 0)}>{d.score ?? 0}%</Badge></td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <IconButton icon={FileText} iconSize={15} variant="soft" label={`Download PDF of the ${d.scenario} drill on ${d.date}`} onClick={() => downloadPdf(d)} />
                        <IconButton icon={Trash2} iconSize={15} variant="soft" className="!text-red-600" label={`Delete the ${d.scenario} drill on ${d.date}`} onClick={() => setRemoving(d)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-surface-200/60 px-4 py-3"
            page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize}
          />
        </div>
      )}

      {/* ── Recorder modal ── */}
      <Modal open={!!scenario} onClose={closeRecorder} title={scenario ? `${scenario.emoji} ${scenario.title}` : ''} maxWidth="max-w-4xl">
        {scenario && (
          <div className="max-h-[76vh] space-y-5 overflow-y-auto pr-1">
            {/* event type toggle */}
            <div className="flex rounded-xl bg-surface-100 p-1">
              {EVENT_TYPES.map((t) => (
                <button key={t} onClick={() => setForm({ ...form, eventType: t })}
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition ${
                    form.eventType === t ? (t === 'Real Emergency' ? 'bg-red-600 text-white' : 'bg-brand-500 text-white') : 'text-ink-500'
                  }`}>{t}</button>
              ))}
            </div>

            {/* context */}
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Site — Region · Entity · Site" className="sm:col-span-3">
                <SiteScopePicker
                  module="drills"
                  sites={siteInventory}
                  value={{ ...form, site: form.centerName }}
                  onChange={(v) => setForm((f) => ({ ...f, ...v, centerName: v.site }))}
                />
              </Field>
              <Field label="Outcome">
                <select className="input" value={form.outcome} onChange={set('outcome')}>{DRILL_OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select>
              </Field>
              <Field label="Date"><input type="date" className="input" max={todayISO()} value={form.date} onChange={set('date')} /></Field>
              <Field label="Time"><input type="time" className="input" value={form.time} onChange={set('time')} /></Field>
              <Field label="Head count"><input type="number" min={0} className="input" value={form.headCount} onChange={set('headCount')} /></Field>
              <Field label="Evacuation time (min)"><input type="number" min={0} className="input" value={form.evacTimeMin} onChange={set('evacTimeMin')} /></Field>
              <Field label="ERT response (min)"><input type="number" min={0} className="input" value={form.ertResponseMin} onChange={set('ertResponseMin')} /></Field>
            </div>

            {/* commanders */}
            <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50/60 p-4 ">
              <p className="mb-1 flex items-center gap-2 text-sm font-bold text-ink-700"><ShieldCheck size={16} /> Incident commanders</p>
              <p className="mb-2 text-xs text-ink-400">
                {autoCmRef.current
                  ? <>Auto-filled with <b>{autoCmRef.current}</b> — the site&apos;s CM from the Emergency Response Plan. Change it if the CM has changed.</>
                  : 'The site CM from the Emergency Response Plan is used by default — pick a site to auto-fill.'}
              </p>
              {commanders.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {commanders.map((n, i) => (
                    <span key={`${n}-${i}`} className="chip bg-brand-50 text-brand-700">
                      {n}<button onClick={() => removeCommander(i)} className="ml-1 text-brand-400 hover:text-brand-700"><X size={12} /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <DeptPersonPicker
                      users={users.filter((u) => u.status === 'approved')}
                      value={commanderPick}
                      onChange={(v) => setCommanderPick(v)}
                      personPlaceholder="Pick from team…"
                    />
                  </div>
                  <button type="button" className="btn-soft px-3" onClick={() => addCommander('db')} disabled={!commanderPick}><Plus size={15} /></button>
                </div>
                <div className="flex gap-2">
                  <input className="input" placeholder="Or type a name…" value={commanderManual}
                    onChange={(e) => setCommanderManual(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCommander('manual') } }} />
                  <button type="button" className="btn-soft px-3" onClick={() => addCommander('manual')} disabled={!commanderManual.trim()}><UserPlus size={15} /></button>
                </div>
              </div>
            </div>

            {/* fire source / medical incident */}
            {scenario.title === 'Fire Emergency' && (
              <Field label="Source of fire *">
                <select className="input" value={form.fireSource} onChange={(e) => { setForm({ ...form, fireSource: e.target.value }); setChecks({}) }}>
                  <option value="">Select fire source…</option>
                  {FIRE_SOURCE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </Field>
            )}
            {scenario.title === 'Medical Emergency' && (
              <Field label="Medical incident type *">
                <select className="input" value={form.medicalIncidentType} onChange={(e) => { setForm({ ...form, medicalIncidentType: e.target.value }); setChecks({}) }}>
                  <option value="">Select medical incident…</option>
                  {MEDICAL_INCIDENT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </Field>
            )}

            {/* teams + checklist */}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50/60 p-4 ">
                <p className="mb-2 text-sm font-bold text-ink-700">Emergency teams alerted</p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {EMERGENCY_TEAMS.map((t, i) => (
                    <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${teamChecks[i] ? 'border-green-300 bg-green-50 text-green-800' : 'border-surface-200'}`}>
                      <input type="checkbox" checked={!!teamChecks[i]} onChange={() => setTeamChecks((p) => ({ ...p, [i]: !p[i] }))} />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
              <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50/60 p-4 ">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-bold text-ink-700">Procedural checklist</p>
                  <span className="chip bg-ink-100 text-ink-600">{Object.values(checks).filter(Boolean).length}/{checklist.length} · {score}%</span>
                </div>
                {checklist.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-surface-200 p-3 text-xs italic text-ink-400">Select the fire source / medical incident to load the checklist.</p>
                ) : (
                  <div className="space-y-1.5">
                    {checklist.map((item, i) => (
                      <label key={i} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${checks[i] ? 'border-brand-200 bg-brand-50' : 'border-surface-200'}`}>
                        <input type="checkbox" className="mt-0.5" checked={!!checks[i]} onChange={() => setChecks((p) => ({ ...p, [i]: !p[i] }))} />
                        <span className={checks[i] ? 'text-ink-400 line-through' : 'text-ink-700'}>{item}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* action log */}
            <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50/60 p-4 ">
              <p className="mb-2 text-sm font-bold text-ink-700">Chronological action log</p>
              <div className="space-y-2">
                {actionLog.map((row, i) => (
                  <div key={i} className="grid grid-cols-[88px_1fr_1fr_auto] gap-2">
                    <input type="time" className="input px-2 py-1.5 text-xs" value={row.time} onChange={(e) => setRow(i, 'time', e.target.value)} />
                    <input className="input px-2 py-1.5" placeholder="Action taken…" value={row.action} onChange={(e) => setRow(i, 'action', e.target.value)} />
                    <input className="input px-2 py-1.5" placeholder="Observation…" value={row.observation} onChange={(e) => setRow(i, 'observation', e.target.value)} />
                    <button className="text-ink-400 hover:text-red-600" onClick={() => delRow(i)}><X size={15} /></button>
                  </div>
                ))}
              </div>
              <button className="btn-soft mt-2 text-xs" onClick={addRow}><Plus size={14} /> Add entry</button>
            </div>

            {/* debrief + capa */}
            <Field label="Debrief notes">
              <textarea className="input" rows={2} value={form.debrief} onChange={set('debrief')} placeholder="Observations, failures, discussion points…" />
            </Field>
            <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50/60 p-4 ">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-bold text-ink-700">Improvement actions (CAPA)</p>
                <button className="btn-soft text-xs" onClick={addCapa}><Plus size={14} /> Add action</button>
              </div>
              {capa.length === 0 ? (
                <p className="rounded-lg border border-dashed border-surface-200 p-3 text-center text-xs italic text-ink-400">No corrective actions.</p>
              ) : (
                <div className="space-y-2">
                  {capa.map((c, i) => (
                    <div key={i} className="rounded-xl border border-surface-200 p-2">
                      <div className="grid grid-cols-[1fr_150px_170px_130px_120px_auto] gap-2">
                        <input className="input px-2 py-1.5" placeholder="Action…" value={c.action} onChange={(e) => setCapaRow(i, 'action', e.target.value)} />
                        {/* A corrective action is owned by a department and worked
                            by named people — a free-text owner gave neither. */}
                        <select className="input px-2 py-1.5" value={c.department || ''} onChange={(e) => setCapaRow(i, 'department', e.target.value)}>
                          <option value="">Department…</option>
                          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select
                          className="input px-2 py-1.5"
                          value=""
                          onChange={(e) => {
                            const u = users.find((x) => x.uid === e.target.value)
                            if (!u) return
                            // One state update for both fields — setCapaRow maps
                            // over the render's capa, so two calls in a row
                            // would have the second clobber the first.
                            setCapa(capa.map((row, idx) => {
                              if (idx !== i) return row
                              const assignees = (row.assignees || []).some((a) => a.uid === u.uid)
                                ? row.assignees
                                : [...(row.assignees || []), { uid: u.uid, name: (u.name || u.email || '').trim() }]
                              // Same cascade the shared DeptPersonPicker gives the
                              // commander field: a person back-fills their department.
                              const department = row.department || u.dept || u.department || ''
                              return { ...row, assignees, department }
                            }))
                          }}
                        >
                          <option value="">Assign person…</option>
                          {users
                            .filter((u) => u.status === 'approved')
                            .filter((u) => !c.department || (u.dept || '') === c.department)
                            .map((u) => <option key={u.uid} value={u.uid}>{u.name || u.email}</option>)}
                        </select>
                        <input type="date" className="input px-2 py-1.5" value={c.due} onChange={(e) => setCapaRow(i, 'due', e.target.value)} />
                        <select className="input px-2 py-1.5" value={c.status} onChange={(e) => setCapaRow(i, 'status', e.target.value)}>{CAPA_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
                        <button className="text-ink-400 hover:text-red-600" onClick={() => delCapa(i)}><X size={15} /></button>
                      </div>
                      {(c.assignees || []).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {c.assignees.map((a) => (
                            <span key={a.uid} className="chip bg-violet-50 text-violet-700">
                              {a.name}
                              <button
                                type="button"
                                className="ml-1 text-violet-400 hover:text-red-600"
                                onClick={() => setCapaRow(i, 'assignees', c.assignees.filter((x) => x.uid !== a.uid))}
                              >
                                <X size={11} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* evidence photos */}
            <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50/60 p-4 ">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-bold text-ink-700">Evidence photos</p>
                <span className="text-xs text-ink-400">{photos.length}/{MAX_DRILL_PHOTOS}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {photos.map((p) => (
                  <div key={p.id} className="group relative">
                    <button type="button" onClick={() => setEnlarge(p.dataUrl)} aria-label="Enlarge drill evidence photo" className="block"><img src={safeSrc(p.dataUrl)} alt="Drill evidence" className="h-20 w-20 cursor-pointer rounded-lg border border-surface-200 object-cover" /></button>
                    <button type="button" onClick={() => removeDrillPhoto(p.id)} className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-red-600 text-white shadow" title="Remove"><X size={11} /></button>
                  </div>
                ))}
                {photos.length < MAX_DRILL_PHOTOS && (
                  <label className="grid h-20 w-20 cursor-pointer place-items-center rounded-lg border border-dashed border-surface-300 text-ink-400 hover:bg-surface-50">
                    {uploadingPhoto ? <Spinner size={18} /> : <ImagePlus size={18} />}
                    <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={onDrillPhoto} disabled={uploadingPhoto} />
                  </label>
                )}
              </div>
              <p className="mt-2 text-xs text-ink-400">Photos of the drill, assembly point, issues, etc. Each image up to 10 MB.</p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-surface-200/60 pt-4">
              <button className="btn-ghost" onClick={closeRecorder}>Cancel</button>
              <button className="btn-primary" onClick={submit} disabled={busy || uploadingPhoto}>
                {busy ? <Spinner size={16} /> : (<><ShieldCheck size={16} /> Submit report</>)}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Detail / view modal ── */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing ? `${getScenario(viewing.scenario)?.emoji || ''} ${viewing.scenario}` : ''} maxWidth="max-w-2xl">
        {viewing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={viewing.eventType === 'Real Emergency' ? '#dc2626' : '#3b82f6'}>{viewing.eventType}</Badge>
              <Badge color={scoreColor(viewing.score || 0)}>{viewing.score ?? 0}%</Badge>
              <span className="text-sm text-ink-500">{viewing.centerName} · {viewing.date} {viewing.time}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[['Evac', viewing.evacTimeMin != null ? `${viewing.evacTimeMin} min` : '—'],
                ['ERT', viewing.ertResponseMin != null ? `${viewing.ertResponseMin} min` : '—'],
                ['Head count', viewing.headCount ?? '—'],
                ['Outcome', viewing.outcome || '—']].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-surface-100 p-3"><p className="text-xs text-ink-500">{k}</p><p className="font-bold text-ink-800">{v}</p></div>
              ))}
            </div>
            <div><p className="label">Commander(s)</p><p className="text-sm text-ink-700">{viewing.commander || '—'}</p></div>
            {viewing.checklist?.length > 0 && (
              <div>
                <p className="label">Checklist ({viewing.score ?? 0}%)</p>
                <ul className="space-y-1">
                  {viewing.checklist.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className={viewing.checklistStatus?.[i] ? 'text-green-600' : 'text-red-500'}>{viewing.checklistStatus?.[i] ? '✓' : '✗'}</span>
                      <span className={viewing.checklistStatus?.[i] ? 'text-ink-500' : 'text-ink-700'}>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {viewing.debrief && <div><p className="label">Debrief</p><p className="whitespace-pre-wrap rounded-xl bg-surface-100 p-3 text-sm text-ink-700">{viewing.debrief}</p></div>}
            {(viewing.photoCount > 0 || viewPhotos.length > 0) && (
              <div>
                <p className="label">Evidence photos {viewing.photoCount ? `(${viewing.photoCount})` : ''}</p>
                {viewPhotosLoading ? (
                  <div className="flex items-center gap-2 text-sm text-ink-500"><Spinner size={16} /> Loading photos…</div>
                ) : viewPhotos.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {viewPhotos.map((p) => (
                      <button key={p.id} type="button" onClick={() => setEnlarge(p.dataUrl)} aria-label="Enlarge drill evidence photo" className="block"><img src={safeSrc(p.dataUrl)} alt="Drill evidence" className="h-20 w-20 cursor-pointer rounded-lg border border-surface-200 object-cover" /></button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-ink-400">No photos could be loaded.</p>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2 border-t border-surface-200/60 pt-4">
              <button className="btn-ghost" onClick={() => setViewing(null)}>Close</button>
              <button className="btn-primary" onClick={() => { const rec = { ...viewing, photos: viewPhotos.map((p) => p.dataUrl) }; setViewing(null); setPrintRecord(rec) }}><FileText size={16} /> Download PDF</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete record?">
        <p className="text-sm text-ink-600">Permanently delete this <span className="font-semibold">{removing?.scenario}</span> record for <span className="font-semibold">{removing?.centerName}</span>?</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn-danger" onClick={confirmDelete}>Delete</button>
        </div>
      </Modal>

      {/* Full-size photo */}
      <Modal open={!!enlarge} onClose={() => setEnlarge(null)} title="Evidence photo" maxWidth="max-w-2xl">
        {/* safeSrc, like the thumbnail that opened it. This is the same stored
            value; checking it in one place and not the other is how the
            unchecked one gets copied somewhere it does matter. */}
        {enlarge && <img src={safeSrc(enlarge)} alt="Drill evidence" className="max-h-[70vh] w-full rounded-xl object-contain" />}
      </Modal>

      {/* Off-screen printable report */}
      <div style={{ position: 'absolute', left: '-10000px', top: 0 }} aria-hidden>
        <div ref={printRef}><MockDrillReport record={printRecord} /></div>
      </div>
    </div>
  )
}
