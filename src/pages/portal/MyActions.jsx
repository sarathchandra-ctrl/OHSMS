// ─────────────────────────────────────────────────────────────────────────────
// My actions.
//
// CAPA and follow-ups live inside whichever module raised them, so an employee
// with one action in Incidents and one in Inspections had no single place to
// see either. This collects them, and a status change here writes straight back
// into the source record — there is no separate copy to fall out of step.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import { ListChecks } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import { useAuth } from '../../shared/auth/AuthContext'
import { subscribeActions, updateActionStatus, NORM_STATUS, NORM_BY_KEY } from '../../modules/actions/lib/sources'
import { Raised, Inset, PortalHeading } from './ui'
import { myActions } from './myWork'
import IncompleteNotice from '../../shared/ui/IncompleteNotice'

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done', label: 'Done' },
]

export default function MyActions() {
  const { profile } = useAuth()
  const [rows, setRows] = useState([])
  const [incomplete, setIncomplete] = useState(null)
  const [filter, setFilter] = useState('all')
  const [savingKey, setSavingKey] = useState(null)

  useEffect(() => {
    return subscribeActions(({ rows, incomplete }) => { setRows(rows); setIncomplete(incomplete) })
  }, [])

  const mine = useMemo(() => myActions(rows, profile), [rows, profile])
  const counts = useMemo(() => ({
    all: mine.length,
    open: mine.filter((a) => a.norm === 'open').length,
    in_progress: mine.filter((a) => a.norm === 'in_progress').length,
    done: mine.filter((a) => a.norm === 'done').length,
  }), [mine])

  const visible = filter === 'all' ? mine : mine.filter((a) => a.norm === filter)

  const setStatus = async (action, norm) => {
    setSavingKey(action.key)
    try {
      await updateActionStatus(action, norm)
      toast.success(`Marked ${NORM_BY_KEY[norm]?.label || norm}`)
    } catch (e) {
      toastCaught(e, 'Could not update the action')
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="animate-fade-in-up">
      <IncompleteNotice incomplete={incomplete} className="mb-4" />
      <PortalHeading
        icon={ListChecks}
        title="My actions"
        subtitle="Follow-ups assigned to you across every module. A status change writes back to the source record."
      />

      <Inset className="mb-4 flex flex-wrap gap-1.5 p-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`inline-flex items-center gap-2 rounded-2xl px-3.5 py-2 text-[12.5px] font-semibold transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 ${
              filter === f.key ? 'bg-surface text-ink-900 shadow-elev-sm' : 'text-ink-500'
            }`}
          >
            {f.label}
            <span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10.5px] font-bold text-ink-600">
              {counts[f.key]}
            </span>
          </button>
        ))}
      </Inset>

      {visible.length === 0 ? (
        <Raised className="px-6 py-14 text-center">
          <p className="text-[15px] font-bold text-ink-900">
            {mine.length === 0 ? 'Nothing is assigned to you' : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} actions`}
          </p>
          <p className="mx-auto mt-1.5 max-w-[44ch] text-[13px] leading-relaxed text-ink-500">
            {mine.length === 0
              ? 'Actions raised against you in any module — incidents, inspections, audits, permits — will appear here.'
              : 'Try another filter.'}
          </p>
        </Raised>
      ) : (
        <Raised className="overflow-hidden">
          <div className="hidden grid-cols-[1fr_130px_110px_110px_150px] gap-3 border-b border-ink-100 px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-ink-400 lg:grid">
            <span>Action</span><span>Source</span><span>Due</span><span>Priority</span><span>Status</span>
          </div>
          <div className="divide-y divide-ink-100">
            {visible.map((a) => (
              <div
                key={a.key}
                className="grid gap-3 px-5 py-4 transition-colors hover:bg-surface-50 lg:grid-cols-[1fr_130px_110px_110px_150px] lg:items-center"
              >
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-ink-900">{a.title}</p>
                  <p className="mt-0.5 truncate text-[11.5px] text-ink-400">{a.context || a.sourceLabel}</p>
                </div>
                <span className="inline-flex items-center gap-2 text-[12px] text-ink-600">
                  <span className="h-2 w-2 flex-none rounded-full" style={{ background: a.tone || '#ab987f' }} />
                  {a.sourceLabel}
                </span>
                <span className={`text-[12px] ${a.overdue ? 'font-bold text-red-600' : 'text-ink-600'}`}>
                  {a.due || '—'}
                </span>
                <span className="text-[12px] text-ink-600">{a.overdue ? 'Overdue' : 'Normal'}</span>
                <select
                  value={a.norm}
                  disabled={savingKey === a.key}
                  onChange={(e) => setStatus(a, e.target.value)}
                  className="w-full appearance-none rounded-2xl border border-transparent bg-surface px-3 py-2 text-[12.5px] font-semibold text-ink-900  outline-hidden disabled:opacity-50"
                >
                  {NORM_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-ink-100 px-5 py-3 text-[11.5px] text-ink-400">
            <span>Showing {visible.length} of {mine.length}</span>
            <span>Changes save straight to the source record</span>
          </div>
        </Raised>
      )}
    </div>
  )
}
