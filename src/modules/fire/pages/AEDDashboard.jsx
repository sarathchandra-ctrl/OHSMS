import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { HeartPulse, ShieldCheck, Wrench, AlertOctagon, BatteryWarning, Zap, CalendarClock, ArrowRight, AlertTriangle } from 'lucide-react'
import { PageHeader, EmptyState, Spinner } from '../components/ui'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { decideAssetReport } from '../lib/firestore'
import { aedSummary, aedCondition } from '../lib/assetLogic'
import { AED_STATUS_LABEL, AED_STATUS_COLOR } from '../lib/constants'
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

export default function AEDDashboard() {
  const { aeds, pendingReports, incomplete, loading } = useFleet()
  const { profile, isManager } = useAuth()
  const [busyId, setBusyId] = useState(null)
  const today = useMemo(() => new Date(), [])
  const s = useMemo(() => aedSummary(aeds, today), [aeds, today])
  const defects = useMemo(() => pendingReports.filter((r) => r.assetKind === 'aed'), [pendingReports])

  const decideDefect = async (report, approve) => {
    setBusyId(report.id)
    try {
      await decideAssetReport(report, approve, profile?.name, { uid: profile?.uid, name: profile?.name })
      toast.success(approve ? 'Defect confirmed — AED marked out of service' : 'Defect report dismissed')
    } catch (e) {
      toastCaught(e, 'Could not update the report')
    } finally {
      setBusyId(null)
    }
  }

  const bySite = useMemo(() => {
    const m = new Map()
    for (const a of aeds) {
      const site = a.centerName || 'Unassigned'
      if (!m.has(site)) m.set(site, { site, total: 0, attention: 0 })
      const row = m.get(site)
      row.total++
      const c = aedCondition(a, today)
      if (c.due || c.expired) row.attention++
    }
    return Array.from(m.values()).sort((a, b) => b.attention - a.attention || b.total - a.total)
  }, [aeds, today])

  if (loading) return <div className="grid place-items-center py-20"><Spinner size={28} /></div>

  return (
    <div>
      <PageHeader title="AED Dashboard" subtitle="Defibrillator readiness across all sites" icon={HeartPulse}>
        <Link to="/equipment/aed" className="btn-soft">Open AED Repository <ArrowRight size={15} /></Link>
      </PageHeader>


      <IncompleteNotice incomplete={incomplete} className="mb-4" />
      {aeds.length === 0 ? (
        <EmptyState icon={HeartPulse} title="No AEDs yet" hint="Add defibrillators in the AED Repository to see readiness here."
          action={<Link to="/equipment/aed" className="btn-primary">Go to AED Repository</Link>} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat icon={HeartPulse} label="Total AEDs" value={s.total} color="#6366f1" />
            <Stat icon={ShieldCheck} label="Ready" value={s.ready} color="#16a34a" />
            <Stat icon={Wrench} label="Service due" value={s.due} color="#f59e0b" />
            <Stat icon={AlertOctagon} label="Out of service" value={s.outOfService} color="#dc2626" />
            <Stat icon={BatteryWarning} label="Battery expiring ≤30d" value={s.batteryExpiring} color="#ea580c" />
            <Stat icon={Zap} label="Pads expiring ≤30d" value={s.padExpiring} color="#db2777" />
            <Stat icon={CalendarClock} label="Inspection due ≤30d" value={s.inspectionDue} color="#b45309" />
            <Stat icon={AlertTriangle} label="Data not available" value={s.incomplete} color="#f59e0b" />
            <Stat icon={ShieldCheck} label="Sites covered" value={bySite.length} color="#0ea5e9" />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <HealthBar
              title="AED readiness"
              segments={[
                { label: 'Ready', value: s.ready, color: '#16a34a' },
                { label: 'Service due', value: s.due, color: '#f59e0b' },
                { label: 'Out of service', value: s.outOfService, color: '#dc2626' },
              ]}
            />
            <OpenDefectsPanel
              defects={defects}
              hint="AED defects reported from a QR scan appear here for approval."
              onDecide={decideDefect}
              canDecide={isManager}
              busyId={busyId}
            />
          </div>

          <div className="card mt-6 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="bg-surface-100/70 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr><th className="px-4 py-3">Site</th><th className="px-4 py-3 text-center">AEDs</th><th className="px-4 py-3 text-center">Need attention</th></tr>
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

          <div className="mt-3 flex flex-wrap gap-3 text-xs text-ink-500">
            {Object.entries(AED_STATUS_LABEL).map(([k, label]) => (
              <span key={k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: AED_STATUS_COLOR[k] }} /> {label}</span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
