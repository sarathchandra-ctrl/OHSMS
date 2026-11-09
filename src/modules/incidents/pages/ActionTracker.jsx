import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { ListChecks, Filter, AlertTriangle, User, ExternalLink, ClipboardList, Activity } from 'lucide-react'
import { PageHeader, Badge, EmptyState } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useIncidents } from '../context/IncidentContext'
import { can } from '../lib/permissions'
import { setActionStatus, isActionOverdue } from '../lib/actions'
import { ACTION_STATUS, ACTION_STATUS_BY_KEY } from '../lib/constants'

export default function ActionTracker() {
  const { allActions } = useIncidents()
  const { role, user, profile } = useAuth()
  const canManage = can(role, 'action.manage')
  const [status, setStatus] = useState('')
  const [mine, setMine] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const filtered = useMemo(() => {
    return allActions.filter((a) => {
      if (status && a.status !== status) return false
      if (mine && a.ownerUid !== user?.uid) return false
      if (overdueOnly && !isActionOverdue(a)) return false
      return true
    })
  }, [allActions, status, mine, overdueOnly, user])

  const counts = useMemo(() => ({
    total: allActions.length,
    open: allActions.filter((a) => a.status === 'open').length,
    in_progress: allActions.filter((a) => a.status === 'in_progress').length,
    closed: allActions.filter((a) => a.status === 'closed').length,
    overdue: allActions.filter((a) => isActionOverdue(a)).length,
  }), [allActions])

  const changeStatus = async (action, newStatus) => {
    setBusyId(action.id)
    try {
      await setActionStatus(action, newStatus, { uid: user.uid, name: profile.name })
      toast.success('Action updated')
    } catch (e) {
      toastCaught(e, 'Could not update')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader title="Action Tracker" subtitle="Corrective & preventive actions across incidents and illnesses" icon={ListChecks} tourId="actions-header" />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: 'Total', value: counts.total, color: '#6d4c41' },
          { label: 'Open', value: counts.open, color: '#ef4444' },
          { label: 'In Progress', value: counts.in_progress, color: '#f59e0b' },
          { label: 'Closed', value: counts.closed, color: '#22c55e' },
          { label: 'Overdue', value: counts.overdue, color: '#dc2626' },
        ].map((c) => (
          <div key={c.label} className="card p-4">
            <p className="text-2xl font-black" style={{ color: c.color }}>{c.value}</p>
            <p className="text-xs font-medium text-ink-500">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
        <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400"><Filter size={13} /> Filters</span>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {ACTION_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <button className={`chip ${mine ? 'bg-brand-500 text-white' : 'bg-surface-100 text-ink-600'}`} onClick={() => setMine((v) => !v)}><User size={12} /> My actions</button>
        <button className={`chip ${overdueOnly ? 'bg-red-500 text-white' : 'bg-surface-100 text-ink-600'}`} onClick={() => setOverdueOnly((v) => !v)}><AlertTriangle size={12} /> Overdue</button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={ListChecks} title="No actions" hint="Actions created in incident CAPA and illness reports appear here." />
      ) : (
        <div className="space-y-2">
          {filtered.map((a, i) => {
            const overdue = isActionOverdue(a)
            const st = ACTION_STATUS_BY_KEY[a.status]
            const srcPath = a.source === 'incident' ? `/incidents/${a.sourceId}` : `/incidents/illness/${a.sourceId}`
            return (
              <motion.div key={`${a.sourceId}:${a.id}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}
                className="card flex flex-wrap items-center gap-3 p-4">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white" style={{ backgroundColor: a.source === 'incident' ? '#795548' : '#0891b2' }}>
                  {a.source === 'incident' ? <ClipboardList size={16} /> : <Activity size={16} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink-900">{a.description || '(No description)'}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                    <Link to={srcPath} className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline">{a.sourceRef} <ExternalLink size={11} /></Link>
                    {a.ownerName && <span className="inline-flex items-center gap-1"><User size={11} /> {a.ownerName}</span>}
                    {a.dueDate && <span className={overdue ? 'font-bold text-red-600' : ''}>Due {a.dueDate}{overdue ? ' · overdue' : ''}</span>}
                    {a.kind && <span className="capitalize">{a.kind}</span>}
                  </div>
                </div>
                {canManage ? (
                  <select
                    className="input w-auto text-sm"
                    value={a.status}
                    disabled={busyId === a.id}
                    onChange={(e) => changeStatus(a, e.target.value)}
                  >
                    {ACTION_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                ) : (
                  <Badge color={st?.color}>{st?.label || a.status}</Badge>
                )}
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}
