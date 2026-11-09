import { StoredImage } from '../../../shared/storage/StoredImage'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  ClipboardCheck, ArrowLeft, Check, X, Minus, Camera, Trash2, Send, MapPin, Tag,
} from 'lucide-react'
import { PageHeader, Spinner, Field } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { addRecord, completeAssignment } from '../lib/firestore'
import { fileToDataUrl } from '../lib/fileToDataUrl'
import { putFile, MAX_UPLOAD_BYTES, MAX_INLINE_BYTES, tooLargeForInline, formatSize } from '../../../shared/storage'
import { hasAnsweredQuestion, scoreResponses, groupFieldsByCategory, usesCategories } from '../lib/schedule'
import { previousInspection, withRepeatHistory } from '../lib/previousFindings'
import PreviousFindingsPanel, { PreviousFindingNote } from '../components/PreviousFindings'

// ── Pass / Fail / N/A ────────────────────────────────────────────────────────
//
// At MODULE scope, not inside Execute. Defined in the render body it was a new
// component TYPE on every render, so React unmounted and remounted every
// Pass/Fail group in the form on every keystroke anywhere in it — losing focus
// and any in-progress interaction, on a screen somebody fills in one field at a
// time while standing at the thing being inspected.
const PF_OPTIONS = [
  { v: 'Pass', icon: Check, on: 'bg-emerald-500 text-white', off: 'text-emerald-600' },
  { v: 'Fail', icon: X, on: 'bg-red-500 text-white', off: 'text-red-600' },
  { v: 'N/A', icon: Minus, on: 'bg-ink-400 text-white', off: 'text-ink-500' },
]

function PF({ value, onPick }) {
  return (
    <div className="flex gap-2">
      {PF_OPTIONS.map((o) => (
        <button key={o.v} type="button" onClick={() => onPick(o.v)}
          className={`inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold shadow-elev-sm transition active:scale-95 ${value === o.v ? o.on : `bg-surface ${o.off}`}`}>
          <o.icon size={14} /> {o.v}
        </button>
      ))}
    </div>
  )
}

export default function Execute() {
  const navigate = useNavigate()
  const location = useLocation()
  const { profile } = useAuth()
  const { sites, records } = useData()
  const task = location.state?.task

  const [responses, setResponses] = useState({})
  const [inspArea, setInspArea] = useState('')
  const [inspSiteId, setInspSiteId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!task) return
    setInspArea(task.area || '')
    setInspSiteId(task.siteId || '')
    const init = {}
    ;(task.template?.fields || []).forEach((f) => {
      // The category is copied onto the response, not just read off the form:
      // a record has to stay readable after the form it came from is edited,
      // and a question that has since been re-filed would otherwise re-file
      // every inspection ever done against it.
      init[f.id] = {
        label: f.label,
        category: f.category || '',
        type: f.type,
        answer: f.type === 'Multiple Choice' ? [] : '',
        observation: '',
        // Only filled in on a Fail, but initialised for every question so the
        // controlled inputs never flip between uncontrolled and controlled when
        // an answer changes.
        action: '',
        actionOwner: '',
        actionDue: '',
        photoEvidence: null,
        photoEvidenceName: '',
      }
    })
    setResponses(init)
  }, [task])

  // Memoised because `|| []` is a fresh array every render, which would make
  // every memo downstream of it recompute on each keystroke.
  const fields = useMemo(() => task?.template?.fields || [], [task])

  // Only show headings once the form actually uses categories — otherwise every
  // question lands under one "General" banner, which is a label and no
  // information, and pushes the first question further down the phone screen.
  const grouped = useMemo(() => usesCategories(fields), [fields])
  const groups = useMemo(() => groupFieldsByCategory(fields), [fields])

  const progress = useMemo(() => {
    let answered = 0, photoNeed = 0, photoOk = 0
    fields.forEach((f) => {
      const r = responses[f.id]
      if (hasAnsweredQuestion(f, r)) answered += 1
      if (f.photoRequirement === 'Mandatory') {
        photoNeed += 1
        if (r?.photoEvidence) photoOk += 1
      }
    })
    return { total: fields.length, answered, percent: fields.length ? Math.round((answered / fields.length) * 100) : 0, photoNeed, photoOk }
  }, [fields, responses])

  const live = useMemo(() => scoreResponses(responses), [responses])

  // What the last run of this form at this site found. Keyed on the site the
  // inspector actually selects, not the scheduled one, so picking a different
  // site swaps the history rather than showing another site's findings.
  const previous = useMemo(
    () => previousInspection(records, {
      templateId: task?.templateId,
      siteId: inspSiteId || task?.siteId || '',
      fields,
    }),
    [records, task?.templateId, task?.siteId, inspSiteId, fields]
  )

  if (!task) {
    return (
      <div>
        <PageHeader icon={ClipboardCheck} title="Run inspection" />
        <div className="card p-8 text-center text-sm text-ink-500">
          No inspection selected. Pick one from the{' '}
          <button className="font-semibold text-brand-600 hover:underline" onClick={() => navigate('/inspections/schedule')}>Schedule</button>{' '}
          or <button className="font-semibold text-brand-600 hover:underline" onClick={() => navigate('/inspections/overdue')}>Overdue</button> list.
        </div>
      </div>
    )
  }

  const update = (fid, patch) => setResponses((p) => ({ ...p, [fid]: { ...(p[fid] || {}), ...patch } }))

  const onPhoto = async (fid, e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_UPLOAD_BYTES) {
      return toast.error(`Photo too large (${formatSize(file.size)}). Max ${formatSize(MAX_UPLOAD_BYTES)}.`)
    }
    // Cloud first. photoEvidence is rendered straight into an <img src>, so a
    // URL drops in where the data URL used to sit and no renderer changes.
    const up = await putFile('inspection-photos', file, file.name)
    if (up) {
      update(fid, { photoEvidence: up.url, photoEvidencePath: up.path, photoEvidenceName: file.name })
      return
    }
    if (file.size > MAX_INLINE_BYTES) return toast.error(tooLargeForInline(file.name))
    update(fid, { photoEvidence: await fileToDataUrl(file), photoEvidenceName: file.name })
  }

  const submit = async () => {
    const errors = []
    fields.forEach((f, i) => {
      const r = responses[f.id]
      if (!hasAnsweredQuestion(f, r)) errors.push(`Question ${i + 1} is unanswered.`)
      if (f.photoRequirement === 'Mandatory' && !r?.photoEvidence) errors.push(`Question ${i + 1} requires a photo.`)
      // A failure with no action is a finding nobody owns. Blocking here rather
      // than nudging afterwards, because "afterwards" is a list somebody else
      // reads a week later without knowing what the inspector saw.
      if (r?.answer === 'Fail' && !String(r.action || '').trim()) {
        errors.push(`Question ${i + 1} failed — say what will be done about it.`)
      }
    })
    if (errors.length) return toast.error(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ''))

    const { score, result } = scoreResponses(responses)
    // Each failure is already an action in the tracker. Stamping the repeat
    // chain here is what lets a fault failing for the third month running be
    // told apart from one found today.
    const stamped = withRepeatHistory(responses, previous)
    const site = sites.find((s) => s.id === inspSiteId)
    const record = {
      templateId: task.templateId,
      templateTitle: task.title,
      siteId: inspSiteId || '',
      siteName: site?.name || task.siteName || '',
      area: inspArea.trim(),
      ...(task.assignmentId ? { assignmentId: task.assignmentId } : {}),
      inspector: profile?.name || '',
      completedAt: new Date().toISOString(),
      scheduledFor: task.dueString || '',
      dueString: task.dueString || '',
      frequency: task.frequency || '',
      score,
      passFailResult: result,
      responses: stamped,
    }
    setBusy(true)
    try {
      await addRecord(record, profile)
      // Take the assignment off the schedule now that it has been done.
      // Nothing ever did this: the only statuses written were Pending and
      // Cancelled, so a completed assigned inspection stayed Pending forever
      // and kept rolling into overdueTasks. Deliberately NOT awaited into the
      // failure path — the record is the thing that matters and it has landed,
      // and schedule.js now drops a completed one-off on the record alone.
      if (task.assignmentId) completeAssignment(task.templateId, task.assignmentId)
      toast.success(`Inspection submitted — ${score}% (${result})`)
      navigate('/inspections/records')
    } catch (e) {
      toastCaught(e, 'Submit failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button onClick={() => navigate(-1)} className="mb-4 inline-flex items-center gap-2 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft size={16} /> Back
      </button>
      <PageHeader icon={ClipboardCheck} title={task.title} subtitle={`${task.frequency || 'One-off'}${task.dueString ? ' · due ' + task.dueString : ''}`} />

      {/* Progress + meta */}
      <div className="card mb-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-[220px] flex-1">
            <div className="mb-1 flex justify-between text-xs font-semibold text-ink-500">
              <span>{progress.answered}/{progress.total} answered</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-200">
              <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${progress.percent}%` }} />
            </div>
            {progress.photoNeed > 0 && (
              <p className="mt-1.5 text-[11px] text-ink-400">{progress.photoOk}/{progress.photoNeed} mandatory photos attached</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-widest text-ink-400">Live score</p>
            <p className={`text-2xl font-black ${live.result === 'PASS' ? 'text-emerald-600' : 'text-red-600'}`}>{live.score}%</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            {/* A heading: what follows is either a read-only div or a picker, decided at
              render time, so there is no control this can name in every case. */}
            <span className="label"><MapPin size={12} className="mr-1 inline" /> Site</span>
            {task.siteId && task.siteName ? (
              <div className="input flex items-center bg-canvas font-semibold text-ink-700">{task.siteName}</div>
            ) : (
              <select className="input" value={inspSiteId} onChange={(e) => setInspSiteId(e.target.value)}>
                <option value="">{sites.length ? 'Select a site…' : 'No sites available'}</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>)}
              </select>
            )}
          </div>
          <Field label="Area / sub-location (optional)">
            <input className="input" value={inspArea} placeholder="e.g. Warehouse B" onChange={(e) => setInspArea(e.target.value)} />
          </Field>
        </div>
      </div>

      {/* What the last run of this form found here, before anything is answered. */}
      <PreviousFindingsPanel previous={previous} />

      {/* Questions, under their category headings. The numbering stays the
          form's own — question 7 is the seventh question on the form, not the
          first of the second group, because that is the number the submission
          errors quote and the number a record is read back against. */}
      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.category}>
            {grouped && (
              <h3 className="mb-2 flex flex-wrap items-baseline gap-2 px-1">
                <Tag size={13} className="translate-y-0.5 text-brand-600" />
                <span className="text-xs font-bold uppercase tracking-widest text-ink-700">{group.category}</span>
                <span className="text-[11px] font-semibold text-ink-400">
                  {group.fields.length} question{group.fields.length === 1 ? '' : 's'}
                </span>
              </h3>
            )}
            <div className="space-y-3">
              {group.fields.map(({ field: f, index: i }) => {
                const r = responses[f.id] || {}
                const lastFail = previous?.byField.get(f.id)
                return (
                  <div key={f.id} className={`card p-5 ${lastFail ? 'border-l-4 border-amber-300' : ''}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex-1">
                        <p className="font-semibold text-ink-800">
                          <span className="mr-2 text-ink-400">{i + 1}.</span>{f.label}
                        </p>
                        <div className="mt-1 flex gap-2 text-[10px] font-bold uppercase tracking-widest text-ink-400">
                          <span>{f.type}</span>
                          {f.photoRequirement !== 'Not Required' && <span className="text-brand-600">📷 {f.photoRequirement}</span>}
                        </div>
                        <PreviousFindingNote finding={lastFail} />
                      </div>
                      <div>
                        {f.type === 'Pass/Fail' && (
                          <PF
                            value={r.answer}
                            onPick={(v) => update(f.id, { answer: v, observation: v === 'Fail' ? r.observation || '' : '' })}
                          />
                        )}
                        {f.type === 'Number' && (
                          <input type="number" className="input w-40" placeholder="Value" value={r.answer ?? ''}
                            onChange={(e) => update(f.id, { answer: e.target.value })} />
                        )}
                        {f.type === 'Text Input' && (
                          <input className="input w-56" placeholder="Answer" value={r.answer ?? ''}
                            onChange={(e) => update(f.id, { answer: e.target.value })} />
                        )}
                        {f.type === 'Single Choice' && (
                          <div className="flex max-w-md flex-wrap justify-end gap-2">
                            {(f.options || []).map((opt) => {
                              const sel = r.answer === opt
                              return (
                                <button key={opt} type="button" onClick={() => update(f.id, { answer: opt })}
                                  className={`rounded-xl px-3 py-2 text-xs font-bold shadow-elev-sm transition active:scale-95 ${sel ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600'}`}>
                                  {opt}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        {f.type === 'Multiple Choice' && (
                          <div className="flex max-w-md flex-wrap justify-end gap-2">
                            {(f.options || []).map((opt) => {
                              const arr = Array.isArray(r.answer) ? r.answer : []
                              const sel = arr.includes(opt)
                              return (
                                <button key={opt} type="button"
                                  onClick={() => update(f.id, { answer: sel ? arr.filter((x) => x !== opt) : [...arr, opt] })}
                                  className={`inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold shadow-elev-sm transition active:scale-95 ${sel ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600'}`}>
                                  {sel && <Check size={13} />}{opt}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* A failure IS an action. The Action Tracker has always
                        derived one from a Fail, but it could only ever quote the
                        observation back — "Extinguisher blocked" — which records
                        the fault and not what anyone intends to do about it. The
                        person who found it, standing there, is the one who knows;
                        asking later means asking someone who was not present. */}
                    {f.type === 'Pass/Fail' && r.answer === 'Fail' && (
                      <div className="ring-1 ring-ink-200 mt-3 space-y-2 rounded-2xl bg-surface-50 p-3 ">
                        <textarea
                          className="input min-h-[60px]"
                          placeholder="What is wrong? (observation)"
                          aria-label={`Observation for question ${i + 1}`}
                          value={r.observation ?? ''}
                          onChange={(e) => update(f.id, { observation: e.target.value })}
                        />
                        <textarea
                          className="input min-h-[60px]"
                          placeholder="What will be done about it? (corrective action — required)"
                          aria-label={`Corrective action for question ${i + 1}`}
                          value={r.action || ''}
                          onChange={(e) => update(f.id, { action: e.target.value })}
                        />
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <input
                            className="input"
                            placeholder="Owner (optional)"
                            aria-label={`Action owner for question ${i + 1}`}
                            value={r.actionOwner || ''}
                            onChange={(e) => update(f.id, { actionOwner: e.target.value })}
                          />
                          <input
                            type="date"
                            className="input font-mono"
                            aria-label={`Action due date for question ${i + 1}`}
                            value={r.actionDue || ''}
                            onChange={(e) => update(f.id, { actionDue: e.target.value })}
                          />
                        </div>
                        <p className="text-[11px] text-ink-400">
                          This opens an item in the Action Tracker when the inspection is submitted.
                        </p>
                      </div>
                    )}

                    {/* Photo */}
                    {f.photoRequirement !== 'Not Required' && (
                      <div className="mt-3">
                        {r.photoEvidence ? (
                          <div className="flex items-center gap-3">
                            <StoredImage pointer={{ url: r.photoEvidence, path: r.photoEvidencePath }} alt="evidence" className="h-16 w-16 rounded-xl object-cover shadow-elev-sm" />
                            <span className="text-xs text-ink-500">{r.photoEvidenceName}</span>
                            <button onClick={() => update(f.id, { photoEvidence: null, photoEvidenceName: '' })}
                              className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={15} /></button>
                          </div>
                        ) : (
                          <label className="btn-ghost inline-flex cursor-pointer text-xs">
                            <Camera size={14} /> Attach photo
                            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onPhoto(f.id, e)} />
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="sticky bottom-24 mt-6 flex justify-end md:bottom-4">
        <button className="btn-primary min-h-12 w-full shadow-glow sm:w-auto" onClick={submit} disabled={busy}>
          {busy ? <Spinner size={16} /> : <><Send size={16} /> Submit inspection</>}
        </button>
      </div>
    </div>
  )
}
