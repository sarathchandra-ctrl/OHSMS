import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import { ListChecks, AlertTriangle, CircleDot, Loader2, CheckCircle2, ExternalLink, Search, Repeat } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import { PageHeader, Card, Select, StatCard, EmptyState, SkeletonTable, Pager } from '../../shared/ui'
import { usePagination } from '../../shared/ui/usePagination'
import { SOURCES, NORM_STATUS, NORM_BY_KEY, subscribeActions, updateActionStatus, isOverdue, todayISO } from './lib/sources'
import IncompleteNotice from '../../shared/ui/IncompleteNotice'
import { readableOnTint } from '../../shared/lib/contrast'

const fmtDue = (due) => (due ? due : '—')

export default function ActionTracker() {
  const { isApproved } = useAuth()
  const [rows, setRows] = useState(null)
  const [incomplete, setIncomplete] = useState(null)
  const [busyKey, setBusyKey] = useState(null)
  const [f, setF] = useState({ source: 'all', status: 'all', q: '', overdue: false, repeating: false })

  useEffect(() => {
    return subscribeActions(({ rows, incomplete }) => { setRows(rows); setIncomplete(incomplete) })
  }, [])

  const today = todayISO()

  const stats = useMemo(() => {
    const list = rows || []
    return {
      total: list.length,
      open: list.filter((r) => r.norm === 'open').length,
      in_progress: list.filter((r) => r.norm === 'in_progress').length,
      done: list.filter((r) => r.norm === 'done').length,
      overdue: list.filter((r) => isOverdue(r.due, r.norm, today)).length,
      // Still open and already failed more than once — the ones being ignored.
      repeating: list.filter((r) => r.repeat > 1 && r.norm !== 'done').length,
    }
  }, [rows, today])

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase()
    return (rows || [])
      .filter((r) => (f.source === 'all' ? true : r.source === f.source))
      .filter((r) => (f.status === 'all' ? true : r.norm === f.status))
      .filter((r) => (f.overdue ? isOverdue(r.due, r.norm, today) : true))
      .filter((r) => (f.repeating ? r.repeat > 1 : true))
      .filter((r) => (q ? `${r.title} ${r.owner} ${r.context} ${r.sourceLabel}`.toLowerCase().includes(q) : true))
      .sort((a, b) => {
        // Overdue first, then the ones that keep coming back, then by due date
        // (blank last). A fault on its fourth inspection has been overlooked
        // three times already, so it should not sit below a fresh one.
        const ao = isOverdue(a.due, a.norm, today) ? 0 : 1
        const bo = isOverdue(b.due, b.norm, today) ? 0 : 1
        if (ao !== bo) return ao - bo
        if (a.repeat !== b.repeat) return b.repeat - a.repeat
        return (a.due || '9999').localeCompare(b.due || '9999')
      })
  }, [rows, f, today])

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filtered)

  const changeStatus = async (row, norm) => {
    setBusyKey(row.key)
    try {
      await updateActionStatus(row, norm)
      toast.success(`Updated in ${row.sourceLabel} → ${NORM_BY_KEY[norm]?.label}`)
    } catch (e) {
      toastCaught(e, 'Could not update the action')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Action Tracker"
        subtitle="Every CAPA & action item across all modules — update status here and it writes back to the source."
        icon={ListChecks}
      />

      {/* Before the counts, not after. "Total actions" is the first thing read
          on this page, and a caveat underneath it arrives too late. */}
      <IncompleteNotice incomplete={incomplete} className="mb-5" />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total actions" value={stats.total} icon={ListChecks} tone="brand" />
        <StatCard label="Open" value={stats.open} icon={CircleDot} tone="red" />
        <StatCard label="In progress" value={stats.in_progress} icon={Loader2} tone="amber" />
        <StatCard label="Done" value={stats.done} icon={CheckCircle2} tone="green" />
        <StatCard label="Overdue" value={stats.overdue} icon={AlertTriangle} tone="red" />
        <StatCard label="Repeating" value={stats.repeating} icon={Repeat} tone="amber" />
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-9"
              placeholder="Search action, owner, source…"
              value={f.q}
              onChange={(e) => setF((p) => ({ ...p, q: e.target.value }))}
            />
          </div>
          <Select className="!w-auto" value={f.source} onChange={(e) => setF((p) => ({ ...p, source: e.target.value }))}>
            <option value="all">All modules</option>
            {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
          <Select className="!w-auto" value={f.status} onChange={(e) => setF((p) => ({ ...p, status: e.target.value }))}>
            <option value="all">All statuses</option>
            {NORM_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
          <label className="ring-1 ring-ink-200 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-surface-50 px-3 py-2 text-sm font-medium text-ink-700 ">
            <input type="checkbox" checked={f.overdue} onChange={(e) => setF((p) => ({ ...p, overdue: e.target.checked }))} />
            Overdue only
          </label>
          <label className="ring-1 ring-ink-200 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-surface-50 px-3 py-2 text-sm font-medium text-ink-700 ">
            <input type="checkbox" checked={f.repeating} onChange={(e) => setF((p) => ({ ...p, repeating: e.target.checked }))} />
            Repeating only
          </label>
        </div>
      </Card>

      {rows === null ? (
        <SkeletonTable rows={6} cols={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={rows.length ? 'No matching actions' : 'No action items yet'}
          description={rows.length ? 'Try clearing the filters above.' : 'CAPA and action items raised in Incidents, Risk Assessment, Committee and Illness will collect here.'}
        />
      ) : (
        <Card className="overflow-hidden !p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((r, i) => {
                  const od = isOverdue(r.due, r.norm, today)
                  return (
                    <motion.tr
                      key={r.key}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.015, 0.3) }}
                      className="hover:bg-surface-100/50"
                      style={{ boxShadow: `inset 4px 0 0 ${r.tone}` }}
                    >
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ backgroundColor: `${r.tone}1a`, color: readableOnTint(r.tone) }}>
                          {r.sourceLabel}
                        </span>
                        <div className="mt-1 max-w-[180px] truncate text-xs text-ink-400" title={r.context}>{r.context}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-[320px] font-medium text-ink-900">{r.title}</div>
                        {r.repeat > 1 && (
                          <span
                            title={r.repeatSince ? `Unresolved since ${fmtDue(r.repeatSince)}` : undefined}
                            className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800"
                          >
                            <Repeat size={10} /> {r.repeat}× running
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-700">{r.owner || <span className="text-ink-300">—</span>}</td>
                      <td className="px-4 py-3">
                        {r.due ? (
                          <span className={od ? 'font-bold text-red-600' : 'text-ink-600'}>
                            {od && <AlertTriangle size={12} className="mr-1 inline" />}{fmtDue(r.due)}
                          </span>
                        ) : <span className="text-ink-300">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={r.norm}
                          disabled={!isApproved || busyKey === r.key}
                          onChange={(e) => changeStatus(r, e.target.value)}
                          className="rounded-lg border px-2.5 py-1.5 text-xs font-bold outline-hidden transition disabled:opacity-60"
                          style={{
                            backgroundColor: `${NORM_BY_KEY[r.norm]?.color}1a`,
                            color: NORM_BY_KEY[r.norm]?.color,
                            borderColor: `${NORM_BY_KEY[r.norm]?.color}55`,
                          }}
                        >
                          {NORM_STATUS.map((s) => <option key={s.key} value={s.key} style={{ color: '#0f172a' }}>{s.label}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link to={r.link} className="btn-ghost px-2.5 py-1.5 text-xs" title="Open in source module">
                          <ExternalLink size={14} />
                        </Link>
                      </td>
                    </motion.tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-ink-100 px-3 py-2"
            page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize}
          />
        </Card>
      )}
    </>
  )
}
