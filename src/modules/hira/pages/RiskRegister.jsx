import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ShieldAlert, CheckCircle2, Pencil, Wrench } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState } from '../components/ui'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { RiskBadge } from '../components/RiskBits'
import { useRa } from '../context/RaContext'
import { useAuth } from '../context/AuthContext'
import { updateAssessment, logActivity } from '../lib/firestore'
import { riskLists, isNonAcceptable } from '../lib/raStats'
import { categoryLabel } from '../lib/constants'
import { readableOnTint, solidBackground } from '../../../shared/lib/contrast'

const GROUPS = [
  { label: 'By severity', tabs: [
    { key: 'critical', label: 'Critical', color: '#991b1b' },
    { key: 'high', label: 'High', color: '#dc2626' },
    { key: 'alarp', label: 'ALARP', color: '#d97706' },
  ] },
  { label: 'Initial risk', tabs: [
    { key: 'acceptableInitial', label: 'Acceptable', color: '#16a34a' },
    { key: 'nonAcceptableInitial', label: 'Non-Acceptable', color: '#ea580c' },
  ] },
  { label: 'Residual risk', tabs: [
    { key: 'acceptableResidual', label: 'Acceptable', color: '#16a34a' },
    { key: 'nonAcceptableResidual', label: 'Non-Acceptable', color: '#ea580c' },
  ] },
  { label: 'Attention', tabs: [
    { key: 'actionRequired', label: 'Action Required', color: '#2563eb' },
  ] },
]

const hazName = (h) => h.hazardType || categoryLabel(h.hazardCategory)

export default function RiskRegister() {
  const { assessments, loading } = useRa()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  // Baselines are activity templates — keep their hazards out of the live register.
  const siteAssessments = useMemo(() => assessments.filter((a) => a.kind !== 'baseline'), [assessments])
  const lists = useMemo(() => riskLists(siteAssessments), [siteAssessments])
  const [tab, setTab] = useState('actionRequired')

  const rows = lists[tab] || []
  // One pager for both layouts below — the cards and the table are the same tab's
  // rows, only ever one of them on screen.
  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(rows)

  const declareAlarp = async (row) => {
    const a = assessments.find((x) => x.id === row.assessmentId)
    if (!a) return
    const activities = (a.activities || []).map((act) => ({
      ...act,
      hazards: (act.hazards || []).map((h) => (h.id === row.hazard.id ? { ...h, alarp: true } : h)),
    }))
    try {
      await updateAssessment(a.id, { activities })
      logActivity({ uid: user?.uid, name: profile?.name }, {
        type: 'alarp',
        message: `declared ALARP on “${hazName(row.hazard)}” (${row.assessmentName})`,
        assessmentId: row.assessmentId,
      })
      toast.success('Declared ALARP — residual risk accepted')
    } catch (e) {
      toastCaught(e, 'Could not update')
    }
  }

  return (
    <div>
      <PageHeader tour="risk-header" title="Risk Register" subtitle="Acceptable / Non-Acceptable, ALARP and high-priority risks." icon={ShieldAlert} />

      {/* Grouped tabs */}
      <div className="card mb-4 flex flex-col gap-3 p-4">
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-[11px] font-bold uppercase tracking-wide text-ink-400">{g.label}</span>
            {g.tabs.map((t) => {
              const count = (lists[t.key] || []).length
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className="chip transition hover:scale-105"
                  style={active ? { backgroundColor: solidBackground(t.color), color: '#fff' } : { backgroundColor: `${t.color}1a`, color: readableOnTint(t.color) }}
                >
                  {t.label}
                  <span className="ml-1 rounded-full bg-white/80 px-1.5 text-[10px] font-extrabold text-ink-700">{count}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={tab === 'actionRequired' ? CheckCircle2 : ShieldAlert} title={loading ? 'Loading…' : 'Nothing here'} hint={tab === 'actionRequired' ? 'No hazards need action — residual risks are acceptable or ALARP-accepted.' : 'No hazards in this category.'} />
      ) : tab === 'actionRequired' ? (
        <div className="space-y-3">
          {pageItems.map((r, i) => {
            const initialBad = isNonAcceptable(r.initial)
            return (
              <motion.div
                key={`${r.assessmentId}-${r.hazard.id}-${i}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 8) * 0.04, duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
                className="card p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-ink-900">{hazName(r.hazard)}</p>
                    <p className="text-xs text-ink-400">{r.assessmentName} · {r.activityTitle}{r.siteName ? ` · ${r.siteName}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-400">Initial</span><RiskBadge risk={r.initial} size="sm" />
                    <span className="text-xs text-ink-400">Residual</span><RiskBadge risk={r.residual} size="sm" />
                  </div>
                </div>
                <div className="mt-3 rounded-2xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
                  {initialBad && <p>• Initial risk is non-acceptable — <strong>apply additional controls</strong> to reduce it.</p>}
                  <p>• Residual risk is non-acceptable — <strong>declare ALARP</strong> (accept as low as reasonably practicable) or <strong>add an action</strong> to reduce it further.</p>
                </div>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Link to={`/hira/create/${r.assessmentId}`} className="btn-ghost"><Wrench size={15} /> Add additional controls</Link>
                  <Link to={`/hira/create/${r.assessmentId}`} className="btn-ghost"><Pencil size={15} /> Edit / add action</Link>
                  <button className="btn-soft" onClick={() => declareAlarp(r)}><CheckCircle2 size={15} /> Declare ALARP</button>
                </div>
              </motion.div>
            )
          })}
          <Pager
            className="card px-4 py-2"
            page={page}
            pageCount={pageCount}
            onPage={setPage}
            total={total}
            pageSize={pageSize}
          />
        </div>
      ) : (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-100/70 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-3">Assessment</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Activity</th>
                  <th className="px-4 py-3">Hazard</th>
                  <th className="px-4 py-3">Initial</th>
                  <th className="px-4 py-3">Residual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {pageItems.map((r, i) => (
                  <tr key={`${r.assessmentId}-${r.hazard.id}-${i}`} className="cursor-pointer transition hover:bg-surface-100/40" onClick={() => navigate(`/hira/assessment/${r.assessmentId}`)}>
                    <td className="px-4 py-3 font-semibold text-ink-900">{r.assessmentName}</td>
                    <td className="px-4 py-3">{r.siteName || '—'}</td>
                    <td className="px-4 py-3">{r.activityTitle}</td>
                    <td className="px-4 py-3">{hazName(r.hazard)}</td>
                    <td className="px-4 py-3"><RiskBadge risk={r.initial} size="sm" /></td>
                    <td className="px-4 py-3"><RiskBadge risk={r.residual} size="sm" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-ink-100 px-3 py-2"
            page={page}
            pageCount={pageCount}
            onPage={setPage}
            total={total}
            pageSize={pageSize}
          />
        </motion.div>
      )}
    </div>
  )
}
