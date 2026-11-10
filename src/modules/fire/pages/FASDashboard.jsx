import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { BellRing, ShieldCheck, Wrench, AlertOctagon, CalendarClock, ArrowRight, AlertTriangle } from 'lucide-react'
import { PageHeader, EmptyState, Spinner } from '../components/ui'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { decideAssetReport } from '../lib/data'
import { fasSummary, fasCondition } from '../lib/assetLogic'
import { FAS_STATUS_LABEL, FAS_STATUS_COLOR, FAS_DEVICE_TYPES, FAS_STATUS } from '../lib/constants'
import { HealthBar, OpenDefectsPanel } from '../components/AssetHealth'
import IncompleteNotice from '../../../shared/ui/IncompleteNotice'

function Stat({ icon: Icon, label, value, color }) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ backgroundColor: `${color}1a`, color }}><Icon size={20} /></div>
      <div className="min-w-0"><p className="text-2xl font-extrabold text-ink-900">{value}</p><p className="truncate text-xs font-semibold text-ink-500">{label}</p></div>
    </div>
  )
}

export default function FASDashboard() {
  const { fas, pendingReports, incomplete, loading } = useFleet()
  const { profile, isManager } = useAuth()
  const [busyId, setBusyId] = useState(null)
  const today = useMemo(() => new Date(), [])
  const s = useMemo(() => fasSummary(fas, today), [fas, today])
  const defects = useMemo(() => pendingReports.filter((r) => r.assetKind === 'fas'), [pendingReports])

  const decideDefect = async (report, approve) => {
    setBusyId(report.id)
    try {
      await decideAssetReport(report, approve, profile?.name, { uid: profile?.uid, name: profile?.name })
      toast.success(approve ? 'Defect confirmed — device marked faulty' : 'Defect report dismissed')
    } catch (e) {
      toastCaught(e, 'Could not update the report')
    } finally {
      setBusyId(null)
    }
  }

  // Always list the standard device types (Control Panel, Smoke/Heat Detector,
  // Manual Call Point, Hooter…) so their counts + faults are visible even at 0.
  const byType = useMemo(() => {
    const m = new Map(FAS_DEVICE_TYPES.map((t) => [t, { type: t, total: 0, faulty: 0, attention: 0 }]))
    for (const a of fas) {
      const t = a.deviceType || 'Other'
      if (!m.has(t)) m.set(t, { type: t, total: 0, faulty: 0, attention: 0 })
      const row = m.get(t); row.total++
      if (a.status === FAS_STATUS.FAULTY) row.faulty++
      const c = fasCondition(a, today); if (c.due || c.expired) row.attention++
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total || a.type.localeCompare(b.type))
  }, [fas, today])

  const bySite = useMemo(() => {
    const m = new Map()
    for (const a of fas) {
      const site = a.centerName || 'Unassigned'
      if (!m.has(site)) m.set(site, { site, total: 0, attention: 0 })
      const row = m.get(site); row.total++
      const c = fasCondition(a, today); if (c.due || c.expired) row.attention++
    }
    return Array.from(m.values()).sort((a, b) => b.attention - a.attention || b.total - a.total)
  }, [fas, today])

  if (loading) return <div className="grid place-items-center py-20"><Spinner size={28} /></div>

  return (
    <div>
      <PageHeader title="FAS Dashboard" subtitle="Fire-alarm system health across all sites" icon={BellRing}>
        <Link to="/equipment/fas" className="btn-soft">Open FAS Repository <ArrowRight size={15} /></Link>
      </PageHeader>


      <IncompleteNotice incomplete={incomplete} className="mb-4" />
      {fas.length === 0 ? (
        <EmptyState icon={BellRing} title="No FAS devices yet" hint="Add fire-alarm devices in the FAS Repository to see system health here."
          action={<Link to="/equipment/fas" className="btn-primary">Go to FAS Repository</Link>} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
            <Stat icon={BellRing} label="Total devices" value={s.total} color="#6366f1" />
            <Stat icon={ShieldCheck} label="Operational" value={s.operational} color="#16a34a" />
            <Stat icon={Wrench} label="Service due" value={s.due} color="#f59e0b" />
            <Stat icon={AlertOctagon} label="Faulty" value={s.faulty} color="#dc2626" />
            <Stat icon={CalendarClock} label="Service due ≤30d" value={s.serviceDue} color="#b45309" />
            <Stat icon={AlertTriangle} label="Data not available" value={s.incomplete} color="#f59e0b" />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <HealthBar
              title="FAS health"
              segments={[
                { label: 'Operational', value: s.operational, color: '#16a34a' },
                { label: 'Service due', value: s.due, color: '#f59e0b' },
                { label: 'Faulty', value: s.faulty, color: '#dc2626' },
              ]}
            />
            <OpenDefectsPanel
              defects={defects}
              hint="FAS defects reported from a QR scan appear here for approval."
              onDecide={decideDefect}
              canDecide={isManager}
              busyId={busyId}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="card overflow-x-auto">
              <p className="border-b border-surface-200/60 px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-500">By device type</p>
              <table className="w-full text-sm">
                <thead className="bg-surface-100/50 text-left text-[11px] uppercase tracking-wide text-ink-500">
                  <tr><th className="px-4 py-2">Type</th><th className="px-4 py-2 text-center">Count</th><th className="px-4 py-2 text-center">Faulty</th><th className="px-4 py-2 text-center">Attention</th></tr>
                </thead>
                <tbody className="divide-y divide-surface-200/60">
                  {byType.map((r) => (
                    <tr key={r.type} className={`hover:bg-ink-50/70 ${r.total === 0 ? 'text-ink-400' : ''}`}>
                      <td className="px-4 py-2.5 font-semibold text-ink-800">{r.type}</td>
                      <td className="px-4 py-2.5 text-center text-ink-600">{r.total}</td>
                      <td className="px-4 py-2.5 text-center">{r.faulty > 0 ? <span className="font-bold text-red-600">{r.faulty}</span> : <span className="text-ink-400">0</span>}</td>
                      <td className="px-4 py-2.5 text-center">{r.attention > 0 ? <span className="font-bold text-amber-600">{r.attention} ⚠</span> : (r.total > 0 ? <span className="text-green-600">OK</span> : <span className="text-ink-300">—</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card overflow-x-auto">
              <p className="border-b border-surface-200/60 px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-500">By site</p>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-surface-200/60">
                  {bySite.map((r) => (
                    <tr key={r.site} className="hover:bg-ink-50/70">
                      <td className="px-4 py-2.5 font-semibold text-ink-800">{r.site}</td>
                      <td className="px-4 py-2.5 text-center text-ink-600">{r.total}</td>
                      <td className="px-4 py-2.5 text-center">{r.attention > 0 ? <span className="font-bold text-amber-600">{r.attention} ⚠</span> : <span className="text-green-600">OK</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-3 text-xs text-ink-500">
            {Object.entries(FAS_STATUS_LABEL).map(([k, label]) => (
              <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: FAS_STATUS_COLOR[k] }} /> {label}</span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
