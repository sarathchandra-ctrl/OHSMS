import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { HeartPulse, Search, CheckCircle2, Clock, ShieldCheck, RotateCcw, ExternalLink, Pencil, Lock, EyeOff } from 'lucide-react'
import { PageHeader, Badge, EmptyState, Modal } from '../components/ui'
import BodyMap from '../components/BodyMap'
import { useIncidents } from '../context/IncidentContext'
import { useAuth } from '../context/AuthContext'
import { can } from '../lib/permissions'
import { setInjuryVerified, injuryStatus, updateInjury } from '../lib/injuries'
import { bodyPartLabel, INCIDENT_TYPE_BY_KEY, SEVERITY_BY_KEY, INJURY_TYPES } from '../lib/constants'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'verified', label: 'Verified' },
]

export default function Injuries() {
  const { injuries, canReadHealth } = useIncidents()
  const { profile } = useAuth()
  const mayVerify = can(profile?.role, 'injury.verify')
  const mayEdit = can(profile?.role, 'incident.report') // reporter / investigator / admin
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(null)
  const [editing, setEditing] = useState(null) // injury being edited
  const [form, setForm] = useState(null)
  const [savingEdit, setSavingEdit] = useState(false)

  const openEdit = (inj) => {
    setEditing(inj)
    setForm({
      firstAidDone: !!inj.firstAidDone,
      firstAidDetail: inj.firstAidDetail || '',
      injuryType: inj.injuryType || '',
      medication: inj.medication || '',
      daysToReturnToWork: inj.daysToReturnToWork ?? '',
      bodyParts: inj.bodyParts || [],
    })
  }
  const saveEdit = async () => {
    setSavingEdit(true)
    try {
      await updateInjury(editing.id, form, { uid: profile?.uid, name: profile?.name })
      toast.success('Injury report updated')
      setEditing(null)
    } catch (e) {
      toastCaught(e, 'Could not update')
    } finally {
      setSavingEdit(false)
    }
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return injuries.filter((i) => {
      if (filter !== 'all' && injuryStatus(i) !== filter) return false
      if (q && !(`${i.personName} ${i.incidentRefNo} ${i.injuryType}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [injuries, filter, search])

  const verify = async (inj, next) => {
    setBusy(inj.id)
    try {
      await setInjuryVerified(inj.id, next, { uid: profile?.uid, name: profile?.name }, `${inj.personName} · ${inj.incidentRefNo}`)
      toast.success(next ? 'Injury report verified' : 'Verification cleared')
    } catch (e) {
      toastCaught(e, 'Could not update')
    } finally {
      setBusy(null)
    }
  }

  const counts = {
    pending: injuries.filter((i) => injuryStatus(i) !== 'verified').length,
    verified: injuries.filter((i) => injuryStatus(i) === 'verified').length,
  }

  // The listener behind `injuries` is only opened for admin and manager, so for
  // anyone else this list is empty for a reason that has nothing to do with how
  // many people have been hurt. Saying "No injury reports" to them would report
  // an absence that was never checked — and now that /injuries is the only copy
  // of the clinical detail, that sentence would be the only thing they ever see.
  if (!canReadHealth) {
    return (
      <div>
        <PageHeader title="Injury Reports" subtitle="Per-person injuries from all incidents." icon={HeartPulse} tourId="injuries-header" />
        <EmptyState
          icon={EyeOff}
          title="Not available to your role"
          hint="Injury reports hold a named colleague's medical detail — body parts, injury type, medication and days to return to work — and are readable by admins and managers only. This is not an empty register. You can still file an injury from an incident's Step 1a."
        />
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Injury Reports" subtitle="Per-person injuries from all incidents — review and verify each one." icon={HeartPulse} tourId="injuries-header" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="ring-1 ring-ink-200 flex gap-1 rounded-xl bg-surface-50 p-1 ">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${filter === f.key ? 'bg-brand-500 text-white shadow-elev-sm' : 'text-ink-500 hover:text-ink-800'}`}
            >
              {f.label}
              {f.key === 'pending' && counts.pending > 0 && <span className="ml-1 rounded-full bg-amber-400/90 px-1.5 text-[10px] font-extrabold text-ink-900">{counts.pending}</span>}
            </button>
          ))}
        </div>
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search person, incident, injury…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={HeartPulse} title="No injury reports" hint="Injury reports are created in an incident (Step 1a) when the type is first-aid, lost-time or reportable. They appear here for independent verification." />
      ) : (
        <div className="space-y-3">
          {rows.map((inj) => {
            const verified = injuryStatus(inj) === 'verified'
            const type = INCIDENT_TYPE_BY_KEY[inj.incidentType]
            const sev = SEVERITY_BY_KEY[inj.severity]
            return (
              <div key={inj.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold text-ink-900">{inj.personName || 'Unnamed person'}</h3>
                      {verified ? (
                        <Badge color="#0ea5e9"><ShieldCheck size={12} /> Verified</Badge>
                      ) : (
                        <Badge color="#f59e0b"><Clock size={12} /> Pending</Badge>
                      )}
                      {inj.injuryType && <Badge color="#dc2626">{inj.injuryType}</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      <Link to={`/incidents/${inj.incidentId}`} className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline">
                        {inj.incidentRefNo || 'Incident'} <ExternalLink size={11} />
                      </Link>
                      {inj.incidentDate && <span> · {inj.incidentDate}</span>}
                      {type && <span> · {type.label}</span>}
                      {sev && <span> · {sev.label}</span>}
                      {inj.location && <span> · {inj.location}</span>}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {verified ? (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-surface-100 px-2.5 py-1.5 text-[11px] font-semibold text-ink-500"><Lock size={12} /> Locked</span>
                    ) : (
                      mayEdit && (
                        <button onClick={() => openEdit(inj)} disabled={busy === inj.id} className="btn-ghost px-3 py-1.5 text-xs">
                          <Pencil size={13} /> Edit
                        </button>
                      )
                    )}
                    {mayVerify && (
                      verified ? (
                        <button onClick={() => verify(inj, false)} disabled={busy === inj.id} className="btn-ghost px-3 py-1.5 text-xs">
                          <RotateCcw size={13} /> Unverify
                        </button>
                      ) : (
                        <button onClick={() => verify(inj, true)} disabled={busy === inj.id} className="btn-primary px-3 py-1.5 text-xs">
                          <CheckCircle2 size={14} /> Verify
                        </button>
                      )
                    )}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                  <Field label="First aid done">{inj.firstAidDone ? `Yes${inj.firstAidDetail ? ` — ${inj.firstAidDetail}` : ''}` : 'No'}</Field>
                  <Field label="Days to return">{inj.daysToReturnToWork !== '' && inj.daysToReturnToWork != null ? inj.daysToReturnToWork : '—'}</Field>
                  <Field label="Medication">{inj.medication || '—'}</Field>
                  <Field label="Medical records">{(inj.recordFileIds || []).length || '—'}</Field>
                </div>

                {(inj.bodyParts || []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {inj.bodyParts.map((k) => <span key={k} className="chip bg-surface-100 text-ink-600">{bodyPartLabel(k)}</span>)}
                  </div>
                )}

                {verified && inj.verifiedByName && (
                  <p className="mt-2 text-[11px] text-ink-400">Verified by {inj.verifiedByName}</p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Edit injury report — ${editing?.personName || ''}`} maxWidth="max-w-2xl">
        {form && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-4">
              <div>
                <span className="label">First aid done?</span>
                <div className="flex gap-2">
                  {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map((o) => (
                    <button key={o.l} type="button" onClick={() => setForm({ ...form, firstAidDone: o.v })}
                      className={`btn ${form.firstAidDone === o.v ? 'bg-brand-500 text-white shadow-elev-brand' : 'bg-surface text-ink-600'}`}>{o.l}</button>
                  ))}
                </div>
                {form.firstAidDone && (
                  <input className="input mt-2" placeholder="First aid details" value={form.firstAidDetail} onChange={(e) => setForm({ ...form, firstAidDetail: e.target.value })} />
                )}
              </div>
              <Field label="Type of injury">
                <select className="input" value={form.injuryType} onChange={(e) => setForm({ ...form, injuryType: e.target.value })}>
                  <option value="">Select injury type…</option>
                  {INJURY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Medication">
                  <input className="input" placeholder="If any" value={form.medication} onChange={(e) => setForm({ ...form, medication: e.target.value })} />
                </Field>
                <Field label="Days to return to work">
                  <input type="number" min="0" className="input" value={form.daysToReturnToWork} onChange={(e) => setForm({ ...form, daysToReturnToWork: e.target.value })} />
                </Field>
              </div>
              <p className="text-xs text-ink-400">Medical record files are managed on the incident’s injury step.</p>
            </div>
            <Field label="Injured body part(s)">
              <BodyMap value={form.bodyParts} onChange={(bodyParts) => setForm({ ...form, bodyParts })} />
            </Field>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setEditing(null)} disabled={savingEdit}>Cancel</button>
          <button className="btn-primary" onClick={saveEdit} disabled={savingEdit}>
            {savingEdit ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </Modal>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">{label}</p>
      <p className="text-ink-800">{children}</p>
    </div>
  )
}
