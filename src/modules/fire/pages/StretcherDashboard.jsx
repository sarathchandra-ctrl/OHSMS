import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Ambulance, ShieldCheck, Wrench, AlertOctagon, CalendarClock, ArrowRight, AlertTriangle, Building2 } from 'lucide-react'
import { PageHeader, EmptyState, Spinner } from '../components/ui'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { decideAssetReport } from '../lib/data'
import { stretcherSummary, stretcherCondition } from '../lib/assetLogic'
import { STRETCHER_STATUS_LABEL, STRETCHER_STATUS_COLOR, STRETCHER_TYPES } from '../lib/constants'
import { HealthBar, OpenDefectsPanel } from '../components/AssetHealth'
import IncompleteNotice from '../../../shared/ui/IncompleteNotice'

function Stat({ icon: Icon, label, value, color }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ backgroundColor: `${color}1a`, color }}>
        <Icon size={20} />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-extrabold text-ink-900">{value}</p>
        <p className="truncate text-xs font-semibold text-ink-500">{label}</p>
      </div>
    </div>
  )
}

// How much of the fleet one type accounts for. A bar alone is a picture of a
// number and reads as nothing at all, so it states the number too.
function ShareBar({ pct }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
        <div className="h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-bold text-ink-600">{pct}%</span>
    </div>
  )
}

export default function StretcherDashboard() {
  const { stretchers, sites, pendingReports, incomplete, loading } = useFleet()
  const { profile, isManager } = useAuth()
  const [busyId, setBusyId] = useState(null)
  const today = useMemo(() => new Date(), [])
  const s = useMemo(() => stretcherSummary(stretchers, today), [stretchers, today])
  const defects = useMemo(() => pendingReports.filter((r) => r.assetKind === 'stretcher'), [pendingReports])

  const decideDefect = async (report, approve) => {
    setBusyId(report.id)
    try {
      await decideAssetReport(report, approve, profile?.name, { uid: profile?.uid, name: profile?.name })
      toast.success(approve ? 'Defect confirmed — stretcher marked out of service' : 'Defect report dismissed')
    } catch (e) {
      toastCaught(e, 'Could not update the report')
    } finally {
      setBusyId(null)
    }
  }

  const bySite = useMemo(() => {
    const m = new Map()
    for (const a of stretchers) {
      const site = a.centerName || 'Unassigned'
      if (!m.has(site)) m.set(site, { site, total: 0, attention: 0 })
      const row = m.get(site)
      row.total++
      const c = stretcherCondition(a, today)
      if (c.due || c.expired) row.attention++
    }
    return Array.from(m.values()).sort((a, b) => b.attention - a.attention || b.total - a.total)
  }, [stretchers, today])

  // Sites with NO stretcher at all. Every other figure on this page is drawn
  // from the register, so a site that has never had one recorded contributes
  // nothing to any of them — it is invisible precisely because it is the worst
  // case. The site list here is the union of every equipment register, which is
  // what makes this countable at all.
  const uncovered = useMemo(() => {
    const have = new Set(stretchers.map((a) => a.centerName).filter(Boolean))
    return sites.filter((site) => !have.has(site))
  }, [stretchers, sites])

  const byType = useMemo(() => {
    const m = new Map(STRETCHER_TYPES.map((t) => [t, 0]))
    for (const a of stretchers) m.set(a.type || 'Other', (m.get(a.type || 'Other') || 0) + 1)
    return [...m.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  }, [stretchers])

  if (loading) return <div className="grid place-items-center py-20"><Spinner size={28} /></div>

  return (
    <div>
      <PageHeader title="Stretcher Dashboard" subtitle="Stretcher readiness and coverage across all sites" icon={Ambulance}>
        <Link to="/equipment/stretchers" className="btn-soft">Open Stretcher Repository <ArrowRight size={15} /></Link>
      </PageHeader>

      <IncompleteNotice incomplete={incomplete} className="mb-4" />

      {stretchers.length === 0 ? (
        <EmptyState icon={Ambulance} title="No stretchers yet" hint="Add stretchers in the Stretcher Repository to see readiness here."
          action={<Link to="/equipment/stretchers" className="btn-primary">Go to Stretcher Repository</Link>} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
            <Stat icon={Ambulance} label="Total stretchers" value={s.total} color="#6366f1" />
            <Stat icon={ShieldCheck} label="Ready" value={s.ready} color="#16a34a" />
            <Stat icon={Wrench} label="Service due" value={s.due} color="#f59e0b" />
            <Stat icon={AlertOctagon} label="Out of service" value={s.outOfService} color="#dc2626" />
            <Stat icon={CalendarClock} label="Inspection due ≤30d" value={s.inspectionDue} color="#b45309" />
            <Stat icon={AlertTriangle} label="Data not available" value={s.incomplete} color="#f59e0b" />
            <Stat icon={Building2} label="Sites covered" value={bySite.length} color="#0ea5e9" />
          </div>

          {uncovered.length > 0 && (
            <div className="card mt-4 flex flex-wrap items-start gap-2 p-4">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink-900">{uncovered.length} site{uncovered.length === 1 ? ' has' : 's have'} no stretcher on the register</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
                  These sites are named on another equipment register but not this one. Every count above is drawn
                  from stretcher records, so a site with none contributes nothing to any of them — the gap is
                  invisible in the figures precisely because it is the largest one.
                </p>
                <p className="mt-1.5 text-[11.5px] text-ink-600">
                  {uncovered.slice(0, 14).join(' · ')}
                  {uncovered.length > 14 && ` · and ${uncovered.length - 14} more`}
                </p>
              </div>
            </div>
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <HealthBar
              title="Stretcher readiness"
              segments={[
                { label: 'Ready', value: s.ready, color: '#16a34a' },
                { label: 'Service due', value: s.due, color: '#f59e0b' },
                { label: 'Out of service', value: s.outOfService, color: '#dc2626' },
              ]}
            />
            <OpenDefectsPanel
              defects={defects}
              hint="Stretcher defects reported from a QR scan appear here for approval."
              onDecide={decideDefect}
              canDecide={isManager}
              busyId={busyId}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="card overflow-hidden">
              <p className="border-b border-surface-200/60 px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-500">By site — most needing attention first</p>
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="sticky top-0 bg-surface-100/90 text-left text-[11px] uppercase tracking-wide text-ink-500">
                    <tr><th className="px-4 py-2">Site</th><th className="px-4 py-2 text-center">Stretchers</th><th className="px-4 py-2 text-center">Need attention</th></tr>
                  </thead>
                  <tbody className="divide-y divide-surface-200/60">
                    {bySite.map((r) => (
                      <tr key={r.site} className="hover:bg-ink-50/70">
                        <td className="px-4 py-2.5 font-semibold text-ink-800">{r.site}</td>
                        <td className="px-4 py-2.5 text-center text-ink-600">{r.total}</td>
                        <td className="px-4 py-2.5 text-center">
                          {r.attention > 0 ? <span className="font-bold text-amber-600">{r.attention}</span> : <span className="text-green-600">0</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card overflow-hidden">
              <p className="border-b border-surface-200/60 px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-500">By type</p>
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-100/90 text-left text-[11px] uppercase tracking-wide text-ink-500">
                    <tr><th className="px-4 py-2">Type</th><th className="px-4 py-2 text-center">Units</th><th className="px-4 py-2">Share</th></tr>
                  </thead>
                  <tbody className="divide-y divide-surface-200/60">
                    {byType.map(([type, n]) => (
                      <tr key={type} className="hover:bg-ink-50/70">
                        <td className="px-4 py-2.5 font-semibold text-ink-800">{type}</td>
                        <td className="px-4 py-2.5 text-center text-ink-600">{n}</td>
                        <td className="px-4 py-2.5"><ShareBar pct={Math.round((n / s.total) * 100)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-3 text-xs text-ink-500">
            {Object.entries(STRETCHER_STATUS_LABEL).map(([k, label]) => (
              <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STRETCHER_STATUS_COLOR[k] }} /> {label}</span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
