import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ClipboardList, ArrowLeft, Pencil, MapPin, Calendar, Building2, Users, AlertTriangle, CheckCircle2, Shield, FileDown,
} from 'lucide-react'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState } from '../components/ui'
import { RiskBadge } from '../components/RiskBits'
import { useRa } from '../context/RaContext'
import { initialRisk, residualRisk } from '../lib/raStats'
import { categoryLabel, CONTROL_STATUS } from '../lib/constants'
import { exportAssessmentPdf } from '../lib/pdf'
import { readableOnTint } from '../../../shared/lib/contrast'

function memberName(members, id) {
  return members?.find((m) => m.id === id)?.name || '—'
}

function statusColor(status) {
  return CONTROL_STATUS.find((s) => s.key === status)?.color || '#64748b'
}

function ControlTable({ controls, members, title }) {
  if (!controls?.length) return null
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-500">{title}</p>
      <div className="ring-1 ring-ink-200 overflow-x-auto rounded-2xl bg-surface-50 ">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase text-ink-400">
            <tr>
              <th className="px-3 py-2">Hierarchy</th>
              <th className="px-3 py-2">Control</th>
              <th className="px-3 py-2">Responsible</th>
              <th className="px-3 py-2">Department</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {controls.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2 font-semibold">{c.hierarchy}</td>
                <td className="px-3 py-2">{c.description}</td>
                <td className="px-3 py-2">{memberName(members, c.responsibleMemberId)}</td>
                <td className="px-3 py-2">{c.department || '—'}</td>
                <td className="px-3 py-2">
                  <span className="chip" style={{ backgroundColor: `${statusColor(c.status)}1a`, color: readableOnTint(statusColor(c.status)) }}>
                    {c.status || 'Open'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function AssessmentView() {
  const { id } = useParams()
  const { assessments, loading } = useRa()
  const a = useMemo(() => assessments.find((x) => x.id === id), [assessments, id])

  if (!a) {
    return (
      <div>
        <PageHeader title="Assessment" icon={ClipboardList}>
          <Link to="/hira/repository" className="btn-ghost"><ArrowLeft size={16} /> Back</Link>
        </PageHeader>
        <EmptyState icon={ClipboardList} title={loading ? 'Loading…' : 'Assessment not found'} hint={loading ? '' : 'It may have been deleted.'} />
      </div>
    )
  }

  const members = a.members || []
  const internal = members.filter((m) => m.type === 'internal')
  const external = members.filter((m) => m.type === 'external')

  return (
    <div>
      <PageHeader title={a.name} subtitle="Hazard identification & risk assessment" icon={ClipboardList}>
        <Link to="/hira/repository" className="btn-ghost"><ArrowLeft size={16} /> Back</Link>
        <button
          className="btn-ghost"
          onClick={() => {
            try { exportAssessmentPdf(a) } catch (e) { toastCaught(e, 'Could not export PDF') }
          }}
        >
          <FileDown size={16} /> Export PDF
        </button>
        <Link to={`/hira/create/${a.id}`} className="btn-primary"><Pencil size={16} /> Edit</Link>
      </PageHeader>

      {/* Details */}
      <div className="card mb-4 grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Detail icon={Building2} label="Facility / Site" value={a.siteName} />
        <Detail icon={MapPin} label="Location" value={a.location} />
        <Detail icon={Calendar} label="Assessment Date" value={a.assessmentDate} />
        <Detail icon={Users} label="Members" value={`${members.length} (${internal.length} internal, ${external.length} external)`} />
      </div>

      {/* Members */}
      {members.length > 0 && (
        <div className="card mb-4 p-5">
          <h3 className="mb-3 font-bold text-ink-900">Team members</h3>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <span key={m.id} className="chip" style={m.type === 'internal' ? { backgroundColor: '#dbeafe', color: '#1d4ed8' } : { backgroundColor: '#f3e8ff', color: '#7e22ce' }}>
                {m.type === 'internal' ? <Shield size={12} /> : <Users size={12} />}
                {m.name}{m.role ? ` · ${m.role}` : ''}{m.department ? ` · ${m.department}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Activities & hazards */}
      <div className="space-y-4">
        {(a.activities || []).map((act, ai) => (
          <motion.div key={act.id || ai} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-5">
            <h3 className="mb-3 flex items-center gap-2 text-lg font-extrabold text-ink-900">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-500 text-xs text-white">{ai + 1}</span>
              {act.title}
            </h3>

            <div className="space-y-4">
              {(act.hazards || []).map((h, hi) => {
                const init = initialRisk(h)
                const resid = residualRisk(h)
                return (
                  <div key={h.id || hi} className="ring-1 ring-ink-200 rounded-2xl bg-canvas/40 p-4 ">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-bold text-ink-900">
                        <AlertTriangle size={16} className="text-brand-500" />
                        {h.hazardType || categoryLabel(h.hazardCategory)}
                      </div>
                      <div className="flex items-center gap-2">
                        {h.alarp && <span className="chip bg-amber-100 text-amber-700"><CheckCircle2 size={12} /> Residual accepted (ALARP)</span>}
                        <span className="text-xs text-ink-400">Initial</span>
                        <RiskBadge risk={init} size="sm" />
                        <span className="text-xs text-ink-400">→ Residual</span>
                        <RiskBadge risk={resid} size="sm" />
                      </div>
                    </div>
                    <div className="grid gap-2 text-sm text-ink-600 sm:grid-cols-2 lg:grid-cols-4">
                      <Field label="Group" value={h.hazardGroup} />
                      <Field label="Category" value={categoryLabel(h.hazardCategory)} />
                      <Field label="Who might be harmed" value={h.whoMightBeHarmed} />
                      <Field label="Specific location" value={h.specificLocation} />
                    </div>
                    {h.description && <p className="mt-2 text-sm text-ink-600">{h.description}</p>}

                    <ControlTable controls={h.controls} members={members} title="Control measures" />
                    <ControlTable controls={h.additionalControls} members={members} title="Additional control measures" />
                  </div>
                )
              })}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function Detail({ icon: Icon, label, value }) {
  return (
    <div className="flex items-start gap-3">
      <div className="ring-1 ring-ink-200 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-50 text-brand-500 "><Icon size={16} /></div>
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">{label}</p>
        <p className="truncate font-semibold text-ink-900">{value || '—'}</p>
      </div>
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <span className="text-[11px] font-bold uppercase tracking-wide text-ink-400">{label}: </span>
      <span>{value || '—'}</span>
    </div>
  )
}
