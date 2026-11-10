import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { format } from 'date-fns'
import { ClipboardCheck, Check, X, AlertTriangle, Truck, Smartphone, Building2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Badge } from '../components/ui'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { approveReport, rejectReport, decideAssetReport } from '../lib/data'
import { DEFECT_BY_KEY, STATUS_LABEL, STATUS_COLOR, REFILL_DEFECT_KEYS } from '../lib/constants'
import { toDate } from '../lib/extinguisherLogic'

function reportMeta(r) {
  if (r.kind === 'asset_defect') {
    const isFas = r.assetKind === 'fas'
    return {
      icon: AlertTriangle,
      title: r.defect || 'Asset defect',
      color: '#dc2626',
      detail: `${isFas ? 'FAS device' : 'AED'} — will mark ${isFas ? 'Faulty' : 'Out of service'}`,
    }
  }
  if (r.kind === 'defect') {
    const d = DEFECT_BY_KEY[r.defectType]
    return {
      icon: AlertTriangle,
      title: d ? d.label : 'Defect',
      color: d ? d.color : '#dc2626',
      detail: REFILL_DEFECT_KEYS.includes(r.defectType) ? 'Will move to To Be Refilled' : 'Will move to Physical Defects',
    }
  }
  return {
    icon: Truck,
    title: STATUS_LABEL[r.newStatus] || 'Status change',
    color: STATUS_COLOR[r.newStatus] || '#6366f1',
    detail: `Will move to ${STATUS_LABEL[r.newStatus] || r.newStatus}`,
  }
}

export default function Approvals() {
  const { reports, pendingReports } = useFleet()
  const { orgName, profile } = useAuth()
  const [busyId, setBusyId] = useState(null)
  const history = reports.filter((r) => r.approvalStatus !== 'pending').slice(0, 20)

  const decide = async (r, approve) => {
    setBusyId(r.id)
    try {
      const actor = { uid: profile?.uid, name: profile?.name }
      if (r.kind === 'asset_defect') await decideAssetReport(r, approve, profile?.name, actor)
      else if (approve) await approveReport(orgName, r, profile?.name, actor)
      else await rejectReport(r, profile?.name, actor)
      toast.success(approve ? 'Approved & applied' : 'Rejected')
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusyId(null)
    }
  }

  const fmt = (v) => {
    const d = toDate(v)
    return d ? format(d, 'dd MMM, HH:mm') : '—'
  }

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Review defect reports and status changes submitted from the portal or QR scans."
        icon={ClipboardCheck}
      />

      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">
        Pending ({pendingReports.length})
      </h2>

      {pendingReports.length === 0 ? (
        <EmptyState icon={Check} title="All caught up" hint="No submissions waiting for review." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <AnimatePresence>
            {pendingReports.map((r) => {
              const m = reportMeta(r)
              return (
                <motion.div
                  key={r.id}
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="card overflow-hidden p-4"
                  style={{ boxShadow: `inset 4px 0 0 ${m.color}` }}
                >
                  <div className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white" style={{ backgroundColor: m.color }}>
                      <m.icon size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-ink-900">{m.title}</p>
                        <span className="chip bg-ink-100 text-ink-500">
                          {r.source === 'qr' ? <Smartphone size={11} /> : <Building2 size={11} />}
                          {r.source === 'qr' ? 'QR scan' : 'Portal'}
                        </span>
                        {r.reporterRole && (
                          <span className="chip bg-brand-50 text-brand-700">Reported by: {r.reporterRole}</span>
                        )}
                      </div>
                      <p className="text-sm text-ink-500">{r.extLabel || r.assetLabel || r.extId}</p>
                      <p className="mt-0.5 text-xs text-ink-400">{m.detail}</p>
                      {r.note && <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-600">“{r.note}”</p>}
                      <p className="mt-2 text-xs text-ink-400">By {r.reportedByName} · {fmt(r.reportedAt)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busyId === r.id} onClick={() => decide(r, false)}>
                      <X size={14} /> Reject
                    </button>
                    <button className="btn bg-green-600 px-3 py-1.5 text-xs text-white hover:brightness-110" disabled={busyId === r.id} onClick={() => decide(r, true)}>
                      <Check size={14} /> Approve
                    </button>
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}

      {history.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-bold uppercase tracking-wide text-ink-500">Recent decisions</h2>
          <div className="card divide-y divide-ink-100">
            {history.map((r) => {
              const m = reportMeta(r)
              return (
                <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />
                  <span className="font-semibold text-ink-800">{m.title}</span>
                  <span className="text-sm text-ink-400">{r.extLabel || r.assetLabel || r.extId}</span>
                  {r.reporterRole && <span className="chip bg-brand-50 text-brand-700">{r.reporterRole}</span>}
                  <Badge className="ml-auto" color={r.approvalStatus === 'approved' ? '#16a34a' : '#dc2626'}>
                    {r.approvalStatus === 'approved' ? 'Approved' : 'Rejected'}
                  </Badge>
                  <span className="hidden text-xs text-ink-400 sm:inline">{r.reviewedBy}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
