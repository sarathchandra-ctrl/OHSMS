// ─────────────────────────────────────────────────────────────────────────────
// Report an incident — the reason most employees open this app at all.
//
// The admin module's wizard asks for everything an investigation eventually
// needs. This one asks for what the person who saw it actually knows, in three
// steps, and writes a real incident into the same collection — so it arrives in
// the HSE team's queue as a normal record with a normal reference number.
//
// The two deliberate omissions are the point: no field asks who was at fault,
// and nothing is required beyond what makes the report actionable.
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Camera, Check, Info, LifeBuoy } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import { useAuth } from '../../shared/auth/AuthContext'
import { addIncidentPhoto, createIncident, getIncident } from '../../modules/incidents/lib/incidents'
import { readFileAsDataUrl } from '../../shared/lib/files'
import { safeSrc } from '../../shared/safeUrl'
import { syncIncidentInjuries } from '../../modules/incidents/lib/injuries'
import {
  INCIDENT_TYPES, SEVERITY, INJURY_TYPES, typeRequiresInjury,
} from '../../modules/incidents/lib/constants'
import { Raised, Inset, SectionLabel } from './ui'

const LOCATIONS = [
  'Loading Dock', 'Production Floor', 'Warehouse', 'Workshop', 'Laboratory',
  'Car Park', 'Canteen / Kitchen', 'Outdoor / Yard', 'Office',
]

const BODY_PARTS = [
  'Head', 'Eye', 'Face', 'Neck', 'Shoulder', 'Arm', 'Hand', 'Finger',
  'Back', 'Chest', 'Leg', 'Knee', 'Foot', 'Other',
]

const PIPELINE = [
  { label: 'You send it', desc: 'Right now — takes a reference number immediately.' },
  { label: 'HSE lead notified', desc: 'Within minutes, on their dashboard.' },
  { label: 'Triage', desc: 'Severity confirmed and an investigation team formed if needed.' },
  { label: 'Investigation', desc: 'You may be asked what you saw. Not who was at fault.' },
  { label: 'Controls close', desc: 'Corrective actions are tracked until they are done.' },
]

const STEPS = ['What happened', 'Who was hurt', 'Check & send']

const localNow = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

export default function ReportIncident() {
  const { actor, profile } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null) // { refNo }
  const [photo, setPhoto] = useState(null)
  const photoRef = useRef(null)

  const [form, setForm] = useState(() => ({
    // Deep-linked from the home screen's "Log a near miss" card.
    type: params.get('type') || '',
    severity: '',
    when: localNow(),
    location: LOCATIONS[0],
    narrative: '',
    hurt: null, // null = unanswered, so "No" is a choice rather than a default
    bodyParts: [],
    injuryType: '',
    confirmed: false,
  }))
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const needsInjury = typeRequiresInjury(form.type)

  // What is missing, phrased as the next thing to do rather than as an error.
  const blocker = useMemo(() => {
    if (step === 0) {
      if (!form.type) return 'Pick what kind of event it was'
      if (!form.severity) return 'Pick how serious it was'
      if (form.narrative.trim().length < 10) return 'Describe what you saw'
      return null
    }
    if (step === 1) {
      if (form.hurt === null) return 'Tell us whether anyone was hurt'
      if (form.hurt && !form.injuryType) return 'Pick the type of injury'
      return null
    }
    return form.confirmed ? null : 'Confirm the account is accurate'
  }, [step, form])

  const submit = async () => {
    if (blocker) return toast.error(blocker)
    setBusy(true)
    try {
      const [date, time] = form.when.split('T')
      // The reporter IS the injured person on this form, and the uid is what
      // keys their injury report — /injuries doc ids are `${incidentId}__${personId}`.
      // This screen used to write `name`/`uid` instead, which is why nothing it
      // captured ever reached that collection: syncIncidentInjuries skips an
      // entry with no personId. The whole of a portal-reported injury lived on
      // the incident document, where everyone could read it.
      const personId = profile?.uid || actor?.uid || ''
      const personName = profile?.name || 'Reporter'
      const injury = form.hurt
        ? {
            personId,
            personName,
            firstAidDone: false,
            injuryType: form.injuryType,
            bodyParts: form.bodyParts,
          }
        : null
      const id = await createIncident(actor, {
        incidentDate: date || '',
        incidentTime: time || '',
        type: form.type,
        severity: form.severity,
        location: form.location,
        narrative: form.narrative.trim(),
        site: profile?.site || '',
        siteId: profile?.siteId || '',
        // createIncident narrows this to the join key on its own; the clinical
        // half of the same object goes to /injuries below.
        injuryReports: injury ? [injury] : [],
      })
      // createIncident returns only the doc id, but the record numbers itself
      // from the org counter (IRA-YYYY-NNNN) and that is the number the HSE team
      // will search on. Showing the id instead would hand the reporter a
      // reference nobody upstream can find, so read the real one back.
      const saved = await getIncident(id).catch(() => null)
      // A report that says someone was hurt and stores nothing about the injury
      // is worse than one that refuses, so this failure is not swallowed.
      if (injury) await syncIncidentInjuries({ id, ...(saved || {}) }, [injury], actor)
      let photoNote = ''
      if (photo) {
        try {
          await addIncidentPhoto(id, {
            ...photo,
            uploadedBy: personName,
            kind: 'photo',
          })
        } catch {
          // The report itself is already in the queue. Losing the picture is
          // worth saying; throwing it away with the report is not.
          photoNote = 'The report was sent, but the photo could not be attached. Add it from the incident.'
        }
      }
      setDone({ id, refNo: saved?.refNo || '', photoNote })
      toast.success(photoNote || 'Reported — the HSE team has it')
    } catch (e) {
      toastCaught(e, 'Could not send the report')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="animate-fade-in-up">
        <Raised className="mx-auto max-w-lg px-8 py-10 text-center">
          <span className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-accent-leaf text-white shadow-elev">
            <Check size={36} strokeWidth={2.8} />
          </span>
          <h2 className="text-2xl font-extrabold tracking-[-0.02em] text-ink-900">Reported. Thank you.</h2>
          <p className="mx-auto mt-2 max-w-[42ch] text-sm leading-relaxed text-ink-500">
            Your HSE lead has been notified. You&rsquo;ll get an update when the investigation team is formed —
            and you may be asked what you saw.
          </p>
          {done.photoNote && (
            <p className="mx-auto mt-4 max-w-[42ch] text-sm text-amber-800">{done.photoNote}</p>
          )}
          <Inset className="mx-auto mt-6 flex max-w-xs items-center justify-between px-4 py-3">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-400">Reference</span>
            <span className="font-mono text-[13px] font-bold text-ink-900">
              {done.refNo || done.id.slice(0, 8).toUpperCase()}
            </span>
          </Inset>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/portal')}
              className="rounded-2xl bg-brand-600 px-5 py-2.5 text-[13px] font-semibold text-white shadow-elev-brand transition-transform duration-200 ease-emil active:scale-[0.97]"
            >
              Back to home
            </button>
            <button
              type="button"
              onClick={() => { setDone(null); setPhoto(null); setStep(0); set({ type: '', severity: '', narrative: '', hurt: null, bodyParts: [], injuryType: '', confirmed: false }) }}
              className="rounded-2xl bg-surface px-5 py-2.5 text-[13px] font-semibold text-ink-700 shadow-elev-sm transition-transform duration-200 ease-emil active:scale-[0.97]"
            >
              Report another
            </button>
          </div>
        </Raised>
      </div>
    )
  }

  const review = [
    ['What', INCIDENT_TYPES.find((t) => t.key === form.type)?.label || '—'],
    ['How serious', SEVERITY.find((s) => s.key === form.severity)?.label || '—'],
    ['When', form.when.replace('T', ' at ')],
    ['Where', form.location],
    ['Anyone hurt', form.hurt === null ? '—' : form.hurt ? `Yes — ${form.injuryType}` : 'No'],
    ...(form.hurt && form.bodyParts.length ? [['Body part', form.bodyParts.join(', ')]] : []),
    ['In your words', form.narrative.trim() || '—'],
  ]

  return (
    <div className="animate-fade-in-up">
      <div className="mb-5 flex items-center gap-3.5">
        <span className="grid h-11 w-11 flex-none place-items-center rounded-2xl bg-brand-50 text-brand-700 shadow-elev-sm">
          <AlertTriangle size={21} strokeWidth={2.1} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[22px] font-extrabold tracking-[-0.02em] text-ink-900">Report an incident</h1>
          <p className="mt-0.5 text-[13px] text-ink-500">Takes about two minutes. No names needed.</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/portal')}
          className="ml-auto flex-none rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm"
        >
          Cancel
        </button>
      </div>

      <Inset className="mb-5 flex gap-1 p-2">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            // Forward movement is gated by `blocker`; going back is always safe.
            onClick={() => i < step && setStep(i)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-2xl px-3 py-2.5 text-[12.5px] font-semibold transition ${
              i === step ? 'bg-surface text-ink-900 shadow-elev-sm' : 'text-ink-500'
            } ${i < step ? 'cursor-pointer' : ''}`}
          >
            <span
              className={`grid h-[22px] w-[22px] place-items-center rounded-full text-[11px] font-extrabold ${
                i <= step ? 'bg-brand-600 text-white' : 'bg-surface-200 text-ink-500'
              }`}
            >
              {i + 1}
            </span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </Inset>

      <div className="grid items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Raised className="p-6">
          {step === 0 && (
            <div className="animate-fade-in-up">
              <SectionLabel className="mb-2.5 tracking-[0.14em]">What kind of event was it?</SectionLabel>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {INCIDENT_TYPES.map((t) => (
                  <Choice key={t.key} on={form.type === t.key} onClick={() => set({ type: t.key })} dot={t.color}>
                    {t.label}
                  </Choice>
                ))}
              </div>

              <SectionLabel className="mb-2.5 mt-6 tracking-[0.14em]">How serious was it?</SectionLabel>
              <Inset className="flex gap-2 p-1.5">
                {SEVERITY.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => set({ severity: s.key })}
                    className={`flex-1 rounded-2xl px-3 py-2.5 text-[12.5px] font-semibold transition ${
                      form.severity === s.key ? 'bg-surface shadow-elev-sm' : 'text-ink-500'
                    }`}
                    style={form.severity === s.key ? { color: s.color } : undefined}
                  >
                    {s.label}
                  </button>
                ))}
              </Inset>

              <div className="mt-6 grid gap-3.5 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="when">When</label>
                  <input
                    id="when" type="datetime-local" value={form.when}
                    onChange={(e) => set({ when: e.target.value })}
                    className="w-full rounded-2xl border border-transparent bg-surface px-3.5 py-3 text-[13.5px] text-ink-900  outline-hidden"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="where">Where</label>
                  <select
                    id="where" value={form.location}
                    onChange={(e) => set({ location: e.target.value })}
                    className="w-full appearance-none rounded-2xl border border-transparent bg-surface px-3.5 py-3 text-[13.5px] text-ink-900  outline-hidden"
                  >
                    {LOCATIONS.map((l) => <option key={l}>{l}</option>)}
                  </select>
                </div>
              </div>

              <div className="mt-4">
                <label className="label" htmlFor="narrative">In your own words</label>
                <textarea
                  id="narrative" rows={4} value={form.narrative}
                  onChange={(e) => set({ narrative: e.target.value })}
                  placeholder="A pallet was stacked above the line marking and shifted when the forklift reversed…"
                  className="w-full resize-y rounded-[18px] border border-transparent bg-surface p-3.5 text-[13.5px] leading-relaxed text-ink-900  outline-hidden"
                />
                <p className="mt-2 text-[11.5px] text-ink-400">
                  No names needed. Describe what you saw, not who to blame.
                </p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="animate-fade-in-up">
              <SectionLabel className="mb-2.5 tracking-[0.14em]">Was anyone hurt?</SectionLabel>
              <div className="flex gap-2.5">
                {[['No', false], ['Yes', true]].map(([label, val]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => set({ hurt: val, ...(val ? {} : { bodyParts: [], injuryType: '' }) })}
                    className={`flex-1 rounded-2xl px-4 py-3 text-[13px] font-semibold transition ${
                      form.hurt === val
                        ? 'bg-brand-600 text-white shadow-elev-brand'
                        : 'bg-surface text-ink-700 shadow-elev-sm'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {form.hurt === false && (
                <p className="mt-5 rounded-[18px] bg-surface-50 px-4 py-4 text-[13px] leading-relaxed text-ink-500 shadow-elev-sm">
                  Good. A near miss with nobody hurt is still worth reporting — it is the cheapest warning
                  the site will ever get.
                </p>
              )}

              {form.hurt && (
                <div className="animate-fade-in-up">
                  {!needsInjury && (
                    <p className="mt-5 flex items-start gap-2.5 rounded-[18px] bg-amber-50 px-4 py-3 text-[12.5px] leading-relaxed text-amber-900">
                      <Info size={15} className="mt-0.5 flex-none" />
                      You picked <b className="mx-1">{INCIDENT_TYPES.find((t) => t.key === form.type)?.label}</b>
                      but someone was hurt — the HSE team may reclassify this. Report it anyway.
                    </p>
                  )}

                  <SectionLabel className="mb-2.5 mt-6 tracking-[0.14em]">Type of injury</SectionLabel>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {INJURY_TYPES.map((t) => (
                      <Choice key={t} on={form.injuryType === t} onClick={() => set({ injuryType: t })}>
                        {t}
                      </Choice>
                    ))}
                  </div>

                  <SectionLabel className="mb-2.5 mt-6 tracking-[0.14em]">Which body part</SectionLabel>
                  <div className="flex flex-wrap gap-2">
                    {BODY_PARTS.map((b) => {
                      const on = form.bodyParts.includes(b)
                      return (
                        <button
                          key={b}
                          type="button"
                          onClick={() => set({
                            bodyParts: on ? form.bodyParts.filter((x) => x !== b) : [...form.bodyParts, b],
                          })}
                          className={`rounded-full px-3.5 py-2 text-[12.5px] font-semibold transition ${
                            on ? 'bg-brand-600 text-white shadow-elev-brand' : 'bg-surface text-ink-600 shadow-elev-sm'
                          }`}
                        >
                          {b}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="animate-fade-in-up">
              <SectionLabel className="mb-3 tracking-[0.14em]">Check before you send</SectionLabel>
              <div className="mb-4">
                <p className="label">Photo (optional)</p>
                <input
                  ref={photoRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    try {
                      const dataUrl = await readFileAsDataUrl(file)
                      setPhoto({ name: file.name, type: file.type, size: file.size, dataUrl })
                    } catch (err) {
                      toast.error(err?.message || 'Could not read that photo')
                    }
                  }}
                />
                {photo ? (
                  <div className="flex items-center gap-3">
                    <img src={safeSrc(photo.dataUrl)} alt="Attached to this report" className="h-16 w-16 rounded-xl object-cover" />
                    <button type="button" className="btn-ghost min-h-12" onClick={() => setPhoto(null)}>
                      Remove photo
                    </button>
                  </div>
                ) : (
                  <button type="button" className="btn-ghost min-h-12 w-full" onClick={() => photoRef.current?.click()}>
                    <Camera size={16} aria-hidden="true" /> Take or attach a photo
                  </button>
                )}
              </div>
              <Inset className="divide-y divide-ink-100/70 px-4">
                {review.map(([k, v]) => (
                  <div key={k} className="flex gap-4 py-2.5">
                    <span className="w-28 flex-none text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">{k}</span>
                    <span className="min-w-0 flex-1 text-[13px] text-ink-900">{v}</span>
                  </div>
                ))}
              </Inset>

              <button
                type="button"
                onClick={() => set({ confirmed: !form.confirmed })}
                className="mt-4 flex w-full items-start gap-3 rounded-[18px] bg-surface-50 p-4 text-left shadow-elev-sm"
              >
                <span
                  className={`mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-md transition ${
                    form.confirmed ? 'bg-brand-600' : 'bg-surface-50 '
                  }`}
                >
                  {form.confirmed && <Check size={13} strokeWidth={3.4} className="text-white" />}
                </span>
                <span className="text-[12.5px] leading-relaxed text-ink-700">
                  This is an accurate account of what I saw. I understand the HSE team may contact me
                  for the investigation.
                </span>
              </button>
            </div>
          )}

          <div className="mt-6 flex items-center gap-3 border-t border-ink-100 pt-5">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm transition-transform duration-200 ease-emil active:scale-[0.97]"
              >
                Back
              </button>
            )}
            <span className="ml-auto text-right text-[11.5px] text-ink-400">{blocker}</span>
            <button
              type="button"
              disabled={busy || !!blocker}
              onClick={() => (step === 2 ? submit() : setStep((s) => s + 1))}
              className="inline-flex flex-none items-center gap-2 rounded-2xl bg-brand-600 px-5 py-2.5 text-[13px] font-semibold text-white shadow-elev-brand transition-transform duration-200 ease-emil active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {step === 2 ? (busy ? 'Sending…' : 'Send report') : 'Continue'}
              {!busy && <ArrowRight size={15} strokeWidth={2.4} />}
            </button>
          </div>
        </Raised>

        <div className="flex flex-col gap-4">
          <Raised className="p-5">
            <p className="mb-3.5 text-[15px] font-bold tracking-[-0.015em] text-ink-900">What happens next</p>
            <div className="flex flex-col">
              {PIPELINE.map((p, i) => (
                <div key={p.label} className="flex gap-3.5">
                  <div className="flex flex-none flex-col items-center">
                    <span className={`h-2.5 w-2.5 rounded-full ${i === 0 ? 'bg-brand-600' : 'bg-surface-300'}`} />
                    {i < PIPELINE.length - 1 && <span className="w-px flex-1 bg-surface-200" />}
                  </div>
                  <div className="pb-4">
                    <p className="text-[13px] font-semibold text-ink-900">{p.label}</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-400">{p.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </Raised>

          <div className="flex items-start gap-3 rounded-[26px] bg-brand-50 p-5">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-brand-600 text-white">
              <LifeBuoy size={17} strokeWidth={2.3} />
            </span>
            <p className="text-[12.5px] leading-relaxed text-ink-700">
              <b className="text-ink-900">Immediate danger?</b> Don&rsquo;t fill this in first. Call your site
              emergency line, then report.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Choice({ on, onClick, dot, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-12 items-center gap-2.5 rounded-2xl px-4 py-3 text-[13px] font-semibold transition ${
        on ? 'bg-surface-50 text-ink-900 ' : 'bg-surface-50 text-ink-700 shadow-elev-sm'
      }`}
    >
      {dot && <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: dot }} />}
      <span className="flex-1 text-left">{children}</span>
      {on && <Check size={16} strokeWidth={3} className="flex-none text-brand-600" />}
    </button>
  )
}
