import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Plus, Pencil, Trash2, Scale, MessageSquareWarning, Users, Paperclip } from 'lucide-react'
import {
  PageHeader, Button, Input, Select, EmptyState, SkeletonTable, Badge, Pager,
} from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useStakeholder } from '../context/StakeholderContext'
import { deleteEscalation } from '../lib/firestore'
import {
  ESCALATION_STATUS, ESCALATION_STATUS_BY_KEY, SEVERITY_BY_KEY, NOTICE_BY_KEY,
} from '../lib/constants'
import { attachmentSummary } from '../lib/attachments'


export default function Escalations() {
  const { actor, isManager } = useAuth()
  const navigate = useNavigate()
  const { escalations, repeats, loading } = useStakeholder()
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return escalations.filter((e) => {
      if (statusFilter && e.status !== statusFilter) return false
      if (!needle) return true
      return [e.title, e.docId, e.description, e.scope?.siteName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
        || (e.members || []).some((m) =>
          [m.memberId, m.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)))
    })
  }, [escalations, q, statusFilter])

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filtered)

  const remove = async (row) => {
    const warn = row.legalCount
      ? `Delete ${row.title}? ${row.legalCount} legal issue(s) point at it and will show as a broken link.`
      : `Delete ${row.title}?`
    // eslint-disable-next-line no-alert
    if (!window.confirm(warn)) return
    try {
      await deleteEscalation(row.id, row.title, actor)
      toast.success('Deleted')
    } catch (e) {
      toastCaught(e)
    }
  }

  return (
    <>
      <PageHeader
        title="Customer Escalations"
        subtitle={`${escalations.length} logged`}
        actions={isManager && <Button icon={Plus} onClick={() => navigate('/stakeholder/escalations/new')}>Log escalation</Button>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {ESCALATION_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
        <Input
          className="ml-auto max-w-xs"
          placeholder="Search title, member, site…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* Carried over from the removed overview tab. A member on their fourth
          complaint is a different conversation from one on their first, and no
          single row in the table below can show that. */}
      {repeats.length > 0 && (
        <div className="card mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm text-ink-600">
          <Users size={15} className="shrink-0 text-amber-600" />
          <span>
            <b>{repeats.length}</b> repeat complainant{repeats.length === 1 ? '' : 's'}:
          </span>
          {repeats.slice(0, 4).map((m) => (
            <button
              key={m.memberId || m.name}
              type="button"
              onClick={() => setQ(m.memberId || m.name)}
              className="rounded-lg bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
              title="Show their escalations"
            >
              {m.name || m.memberId} ×{m.count}
            </button>
          ))}
          {repeats.length > 4 && <span className="text-xs text-ink-400">+{repeats.length - 4} more</span>}
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={5} />
      ) : !filtered.length ? (
        <EmptyState
          icon={MessageSquareWarning}
          title={q || statusFilter ? 'Nothing matches' : 'No escalations logged'}
          hint={q || statusFilter ? 'Clear the filters to see everything.' : 'Log a customer complaint to start tracking it.'}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-3 py-2">Ref</th>
                <th className="px-3 py-2">Issue</th>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2">Members</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Evidence</th>
                <th className="px-3 py-2">Legal</th>
                {isManager && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((row) => (
                <tr key={row.id} className="border-t border-ink-100">
                  <td className="px-3 py-2 font-mono text-xs">{row.docId || '—'}</td>
                  <td className="px-3 py-2 font-medium text-ink-800">{row.title}</td>
                  <td className="px-3 py-2">{row.scope?.siteName || '—'}</td>
                  <td className="px-3 py-2">
                    {(row.members || []).length
                      ? `${row.members.length} · ${row.members.map((m) => m.memberId || m.name).filter(Boolean).slice(0, 2).join(', ')}${row.members.length > 2 ? '…' : ''}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={SEVERITY_BY_KEY[row.severity]?.tone || 'slate'}>
                      {SEVERITY_BY_KEY[row.severity]?.label || row.severity}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={ESCALATION_STATUS_BY_KEY[row.status]?.tone || 'slate'}>
                      {ESCALATION_STATUS_BY_KEY[row.status]?.label || row.status}
                    </Badge>
                  </td>
                  {/* "We hold the clip" and "we know where it is" are different
                      levels of readiness for a dispute, so they are counted apart. */}
                  <td className="px-3 py-2">
                    {(() => {
                      const s = attachmentSummary(row)
                      if (!s.total) return <span className="text-xs text-ink-400">—</span>
                      const bits = [
                        s.cctvFiles && `${s.cctvFiles} clip${s.cctvFiles > 1 ? 's' : ''}`,
                        s.cctvReferences && `${s.cctvReferences} ref${s.cctvReferences > 1 ? 's' : ''}`,
                        s.ethics && `${s.ethics} ethics`,
                      ].filter(Boolean)
                      return (
                        <span className="flex items-center gap-1 text-xs text-ink-600" title={bits.join(' · ')}>
                          <Paperclip size={12} className="text-ink-400" /> {bits.join(' · ')}
                        </span>
                      )
                    })()}
                  </td>
                  {/* The column that stops a "resolved" complaint reading as
                      settled when it produced an FIR. */}
                  <td className="px-3 py-2">
                    {row.escalated ? (
                      <Badge tone={row.severeNotices.length ? 'red' : 'amber'} title={`${row.legalCount} legal issue(s)`}>
                        <Scale size={11} className="mr-1 inline" />
                        {row.worstNotice ? NOTICE_BY_KEY[row.worstNotice]?.label : `${row.legalCount}`}
                      </Badge>
                    ) : (
                      <span className="text-xs text-ink-400">—</span>
                    )}
                  </td>
                  {isManager && (
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" className="px-2 py-1 text-xs" icon={Pencil} onClick={() => navigate(`/stakeholder/escalations/${row.id}`)} />
                        <Button variant="ghost" className="px-2 py-1 text-xs" icon={Trash2} onClick={() => remove(row)} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            className="border-t border-ink-100 px-3 py-2"
            page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize}
          />
        </div>
      )}

    </>
  )
}
