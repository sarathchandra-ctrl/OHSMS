import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CalendarClock, AlertTriangle, ExternalLink } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState } from '../components/ui'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { RiskBadge } from '../components/RiskBits'
import { useRa } from '../context/RaContext'
import { useAuth } from '../context/AuthContext'
import { patchAdditionalControl, logActivity } from '../lib/firestore'
import { flattenAdditionalControls, isOverdue, isNonAcceptable} from '../lib/raStats'
import { CONTROL_STATUS } from '../lib/constants'

const FILTERS = [
  { key: 'open', label: 'Open actions' }, // Open + In Progress
  { key: 'Open', label: 'Open' },
  { key: 'In Progress', label: 'In Progress' },
  { key: 'Implemented', label: 'Implemented' },
  { key: 'all', label: 'All' },
]

// Track residual-risk vs non-residual(initial)-risk actions separately.
const FOCUS = [
  { key: 'all', label: 'All actions' },
  { key: 'residual', label: 'Residual not acceptable' },
  { key: 'initial', label: 'Initial not acceptable' },
]

const statusColor = (s) => CONTROL_STATUS.find((x) => x.key === s)?.color || '#64748b'
const memberName = (members, id) => members?.find((m) => m.id === id)?.name || '—'

export default function ActionTracker() {
  const { assessments, loading } = useRa()
  const { user, profile } = useAuth()
  const [filter, setFilter] = useState('all')
  const [focus, setFocus] = useState('all')
  const [overdueOnly, setOverdueOnly] = useState(false)

  // Counts per status (across all additional controls) for the filter chips.
  const counts = useMemo(() => {
    const all = flattenAdditionalControls(assessments)
    const c = { all: all.length, open: 0, Open: 0, 'In Progress': 0, Implemented: 0 }
    for (const r of all) {
      const st = r.control.status || 'Open'
      c[st] = (c[st] || 0) + 1
      if (st === 'Open' || st === 'In Progress') c.open += 1
    }
    return c
  }, [assessments])

  const rows = useMemo(() => {
    const all = flattenAdditionalControls(assessments)
    const f = all.filter((r) => {
      const st = r.control.status || 'Open'
      if (filter === 'open') return st === 'Open' || st === 'In Progress'
      if (filter !== 'all') return st === filter
      return true
    }).filter((r) => {
      if (focus === 'residual') return isNonAcceptable(r.residual)
      if (focus === 'initial') return isNonAcceptable(r.initial)
      return true
    }).filter((r) => (overdueOnly ? isOverdue(r.control) : true))
    // Overdue first, then by due date (blank dates last).
    return f.sort((a, b) => {
      const ao = isOverdue(a.control) ? 0 : 1
      const bo = isOverdue(b.control) ? 0 : 1
      if (ao !== bo) return ao - bo
      const ad = a.control.dueDate || '9999-12-31'
      const bd = b.control.dueDate || '9999-12-31'
      return ad.localeCompare(bd)
    })
  }, [assessments, filter, focus, overdueOnly])

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(rows)

  // Persist an inline change to one additional control.
  //
  // Through patchAdditionalControl, which re-reads the assessment inside a
  // transaction. This used to build `activities` from the snapshot this screen
  // was rendering and write the lot back, so closing one action reverted every
  // edit anyone else had made to that assessment since the snapshot arrived —
  // including a hazard added in CreateAssessment, silently, on a risk register.
  const patchControl = async (row, patch) => {
    try {
      await patchAdditionalControl(
        row.assessmentId,
        { activityId: row.activityId, hazardId: row.hazardId, controlId: row.control.id },
        patch,
      )
      if (patch.status) {
        logActivity({ uid: user?.uid, name: profile?.name }, {
          type: 'action',
          message: `set action “${row.control.description || row.control.hierarchy}” to ${patch.status} (${row.assessmentName})`,
          assessmentId: row.assessmentId,
        })
      }
    } catch (e) {
      toastCaught(e, 'Could not update')
    }
  }

  const openCount = useMemo(
    () => flattenAdditionalControls(assessments).filter((r) => ['Open', 'In Progress'].includes(r.control.status || 'Open')).length,
    [assessments]
  )

  return (
    <div>
      <PageHeader tour="actions-header" title="Action Tracker" subtitle="Additional control measures (CAPA) — status & due dates." icon={CalendarClock} />

      <div className="card mb-4 flex flex-wrap items-center gap-2 p-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`chip transition hover:scale-105 ${filter === f.key ? 'bg-brand-600 text-white' : 'bg-surface-100 text-ink-600'}`}
          >
            {f.label}
            <span className={`ml-1 rounded-full px-1.5 text-[10px] font-extrabold ${filter === f.key ? 'bg-white/30 text-white' : 'bg-white/80 text-ink-700'}`}>{counts[f.key] ?? 0}</span>
          </button>
        ))}
        <button
          onClick={() => setOverdueOnly((v) => !v)}
          className={`chip transition hover:scale-105 ${overdueOnly ? 'bg-red-600 text-white' : 'bg-red-50 text-red-600'}`}
        >
          <AlertTriangle size={13} /> Overdue only
        </button>
        <span className="ml-auto text-xs font-semibold text-ink-400">{openCount} open action(s)</span>
        <div className="flex w-full flex-wrap items-center gap-2 border-t border-surface-200/60 pt-3">
          <span className="text-[11px] font-bold uppercase tracking-wide text-ink-400">Risk focus</span>
          {FOCUS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFocus(f.key)}
              className={`chip transition hover:scale-105 ${focus === f.key ? 'bg-magenta-500 text-white' : 'bg-surface-100 text-ink-600'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={loading ? 'Loading…' : 'No matching actions'}
          hint="Additional control measures added to hazards appear here with their status and due dates."
        />
      ) : (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-100/70 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Action</th>
                  <th className="px-3 py-3">Hazard</th>
                  <th className="px-3 py-3">R1</th>
                  <th className="px-3 py-3">R2</th>
                  <th className="px-3 py-3">Assessment</th>
                  <th className="px-3 py-3">Responsible</th>
                  <th className="px-3 py-3">Due date</th>
                  <th className="px-3 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {pageItems.map((r, i) => {
                  const overdue = isOverdue(r.control)
                  return (
                    <tr key={`${r.assessmentId}-${r.control.id}-${i}`} className={overdue ? 'bg-red-50/60' : ''}>
                      <td className="px-3 py-2">
                        <select
                          value={r.control.status || 'Open'}
                          onChange={(e) => patchControl(r, { status: e.target.value })}
                          className="rounded-lg border-0 px-2 py-1 text-xs font-bold text-white shadow-elev-sm outline-hidden"
                          style={{ backgroundColor: statusColor(r.control.status || 'Open') }}
                        >
                          {CONTROL_STATUS.map((s) => <option key={s.key} value={s.key} className="bg-white text-ink-900">{s.label}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-[11px] font-semibold text-ink-400">[{r.control.hierarchy}]</span>{' '}
                        <span className="font-medium text-ink-800">{r.control.description || '—'}</span>
                        <div className="text-[11px] text-ink-400">{r.activityTitle}</div>
                      </td>
                      <td className="px-3 py-2">{r.hazardLabel}{r.alarp && <div className="text-[10px] font-bold uppercase text-amber-600">ALARP</div>}</td>
                      <td className="px-3 py-2"><RiskBadge risk={r.initial} size="sm" /></td>
                      <td className="px-3 py-2"><RiskBadge risk={r.residual} size="sm" /></td>
                      <td className="px-3 py-2">
                        <Link to={`/hira/assessment/${r.assessmentId}`} className="font-semibold text-brand-600 hover:underline">
                          {r.assessmentName}
                        </Link>
                        <div className="text-[11px] text-ink-400">{r.siteName}</div>
                      </td>
                      <td className="px-3 py-2">
                        {memberName(r.members, r.control.responsibleMemberId)}
                        {r.control.department ? <div className="text-[11px] text-ink-400">{r.control.department}</div> : null}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={r.control.dueDate || ''}
                          onChange={(e) => patchControl(r, { dueDate: e.target.value })}
                          className={`rounded-lg bg-surface px-2 py-1 text-xs  outline-hidden ${overdue ? 'text-red-600 font-bold' : 'text-ink-700'}`}
                        />
                        {overdue && <div className="text-[10px] font-bold uppercase text-red-600">Overdue</div>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link to={`/hira/create/${r.assessmentId}`} className="rounded-lg p-1.5 text-ink-400 shadow-elev-sm transition hover:bg-surface-100 hover:text-ink-700" title="Edit assessment"><ExternalLink size={14} /></Link>
                      </td>
                    </tr>
                  )
                })}
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
