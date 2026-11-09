import { Calendar, Clock, Building, Wind, Timer, ShieldCheck, HeartPulse, Users, Paperclip, Link2 } from 'lucide-react'
import PersonEditor from '../PersonEditor'
import BodyMap from '../BodyMap'
import FileUploader from '../FileUploader'
import { HSE_HEALTH_AGENTS, PPE_OPTIONS } from '../../lib/constants'
import SiteScopePicker from '../../../../shared/org/SiteScopePicker'
import { Field } from '../ui'
import { todayISO } from '../../../../shared/lib/dates'

function FieldLabel({ icon: Icon, children }) {
  return <label className="label flex items-center gap-1.5"><Icon size={13} /> {children}</label>
}

/** Illness — Initial Reporting form. `value`/`onChange` controlled by the wizard. */
export default function StepIllnessInitial({ value, onChange, users, incidents = [], sites = [], files = [], onAddFile, onRemoveFile, canEdit = true }) {
  const set = (patch) => onChange({ ...value, ...patch })
  const togglePpe = (p) => {
    const cur = value.ppe || []
    set({ ppe: cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p] })
  }

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <FieldLabel icon={Link2}>Link to an incident (optional)</FieldLabel>
        <select className="input" value={value.linkedIncidentId || ''} onChange={(e) => set({ linkedIncidentId: e.target.value || null })}>
          <option value="">Standalone illness report</option>
          {/* Labelled by site rather than by location: incidents no longer
              collect a free-text area, so every new one would read "no
              location" and the list would stop distinguishing them. */}
          {incidents.map((i) => (
            <option key={i.id} value={i.id}>
              {i.docId || i.refNo} — {i.site || i.location || 'no site'}
            </option>
          ))}
        </select>
      </div>

      <div className="card p-6">
        <FieldLabel icon={Users}>Affected people</FieldLabel>
        <p className="mb-2 text-xs text-ink-400">Add everyone affected — internal staff or external parties.</p>
        <PersonEditor value={value.affectedPersonnel || []} onChange={(affectedPersonnel) => set({ affectedPersonnel })} users={users} />
      </div>

      <div className="card grid grid-cols-1 gap-4 p-6 sm:grid-cols-2">
        <div>
          <FieldLabel icon={Calendar}>Date</FieldLabel>
          <input type="date" className="input" max={todayISO()} value={value.date || ''} onChange={(e) => set({ date: e.target.value })} />
        </div>
        <div>
          <FieldLabel icon={Clock}>Time</FieldLabel>
          <input type="time" className="input" value={value.time || ''} onChange={(e) => set({ time: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <FieldLabel icon={Building}>Site scope</FieldLabel>
          <SiteScopePicker module="incidents" sites={sites} value={value} onChange={set} disabled={!canEdit} />
          {sites.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">You don&apos;t have site access yet — request it from your account menu.</p>
          )}
        </div>
        <div>
          <FieldLabel icon={Wind}>Exposed to agent</FieldLabel>
          <select className="input" value={value.exposedToAgent || ''} onChange={(e) => set({ exposedToAgent: e.target.value })}>
            <option value="">Select agent…</option>
            {HSE_HEALTH_AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel icon={Timer}>Duration of exposure</FieldLabel>
          <input className="input" placeholder="e.g. 3 hours / 6 months" value={value.exposureDuration || ''} onChange={(e) => set({ exposureDuration: e.target.value })} />
        </div>
      </div>

      <div className="card p-6">
        <FieldLabel icon={ShieldCheck}>PPE in use (if any)</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {PPE_OPTIONS.map((p) => {
            const on = (value.ppe || []).includes(p)
            return (
              <button key={p} type="button" onClick={() => togglePpe(p)} className="chip transition"
                style={on ? { backgroundColor: '#6d4c41', color: '#fff' } : { backgroundColor: '#efebe9', color: '#5d4037' }}>
                {p}
              </button>
            )
          })}
        </div>
      </div>

      <div className="card p-6">
        <FieldLabel icon={HeartPulse}>Health issue triggered</FieldLabel>
        <textarea className="input min-h-[100px] resize-y" placeholder="Describe the health issue / symptoms triggered by the exposure…" value={value.healthIssue || ''} onChange={(e) => set({ healthIssue: e.target.value })} />
      </div>

      <Field label="Affected body part(s) — internal & external" className="card p-6">
        <BodyMap value={value.affectedBodyParts || []} onChange={(affectedBodyParts) => set({ affectedBodyParts })} />
      </Field>

      <div className="card p-6">
        <FieldLabel icon={Paperclip}>Attachments</FieldLabel>
        <FileUploader accept="any" label="Add attachment" hint="Image or PDF, up to 2 MB each." disabled={!canEdit} files={files} onAdd={onAddFile} onRemove={onRemoveFile} />
      </div>
    </div>
  )
}
