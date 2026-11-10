import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Eye, CheckCircle2, AlertTriangle, FileText, QrCode, Monitor } from 'lucide-react'
import { PageHeader, EmptyState, Spinner } from '../components/ui'
import { subscribeObservations } from '../lib/data'
import { readableOnTint } from '../../../shared/lib/contrast'

const fmt = (ts) => {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'safe', label: 'Safe' },
  { key: 'unsafe', label: 'Unsafe' },
]

export default function Observations() {
  const [obs, setObs] = useState(null)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    return subscribeObservations(setObs)
  }, [])

  const visible = useMemo(() => {
    if (!obs) return []
    return filter === 'all' ? obs : obs.filter((o) => o.type === filter)
  }, [obs, filter])

  return (
    <div>
      <PageHeader icon={Eye} title="Observations" subtitle="Safety observations logged against permits" tourId="observations-header" />

      <div className="mb-5 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`chip transition ${filter === f.key ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600 hover:bg-surface-100'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {obs === null ? (
        <div className="grid place-items-center py-20"><Spinner size={28} /></div>
      ) : visible.length === 0 ? (
        <EmptyState icon={Eye} title="No observations yet" hint="Observations logged via QR scan or in-app will appear here." />
      ) : (
        <div className="space-y-2.5">
          {visible.map((o, i) => {
            const unsafe = o.type === 'unsafe'
            const pending = o.approvalStatus === 'pending'
            const color = unsafe ? '#991b1b' : '#16a34a'
            const Icon = unsafe ? AlertTriangle : CheckCircle2
            return (
              <motion.div key={o.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}
                className="card p-4" style={{ borderLeft: `4px solid ${color}` }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip" style={{ backgroundColor: `${color}1a`, color: readableOnTint(color) }}><Icon size={13} /> {unsafe ? 'Unsafe' : 'Safe'}</span>
                  <Link to={`/permits/${o.permitId}`} className="inline-flex items-center gap-1 font-bold text-ink-900 hover:text-brand-600">
                    <FileText size={14} /> {o.permitNo || o.permitId}
                  </Link>
                  <span className="ml-auto inline-flex items-center gap-1 text-xs text-ink-400">
                    {o.source === 'qr' ? <QrCode size={12} /> : <Monitor size={12} />} {o.source === 'qr' ? 'QR scan' : 'Portal'}
                  </span>
                </div>
                {o.note && <p className="mt-2 text-sm text-ink-700">{o.note}</p>}
                <p className="mt-1.5 text-xs text-ink-400">
                  {o.observedByName || 'Unknown'} · {fmt(o.at)}
                  {/* Only a signed-in unsafe observation closes the permit. One
                      logged by scanning the QR is a report awaiting a decision,
                      and saying it closed the permit would tell an approver the
                      work had already been stopped when it has not. */}
                  {unsafe && (pending
                    ? <span className="font-semibold text-amber-600"> · reported by scan — permit not closed</span>
                    : <span className="font-semibold text-red-600"> · permit closed for non-compliance</span>)}
                </p>
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}
