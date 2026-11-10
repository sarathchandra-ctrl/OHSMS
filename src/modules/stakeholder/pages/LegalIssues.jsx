import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Plus, Pencil, Trash2, Gavel, Link2Off } from 'lucide-react'
import {
  PageHeader, Button, Input, Select, EmptyState, SkeletonTable, Badge, Pager,
} from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useStakeholder } from '../context/StakeholderContext'
import { deleteLegalIssue } from '../lib/data'
import {
  DEPARTMENTS, DEPARTMENT_BY_KEY, NOTICE_BY_KEY, LEGAL_STATUS_BY_KEY,
} from '../lib/constants'

export default function LegalIssues() {
  const { actor, isManager } = useAuth()
  const navigate = useNavigate()
  const { legalIssues, loading } = useStakeholder()
  const [q, setQ] = useState('')
  const [deptFilter, setDeptFilter] = useState('')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return legalIssues.filter((l) => {
      if (deptFilter && !(l.departments || []).includes(deptFilter)) return false
      if (!needle) return true
      return [l.title, l.docId, l.description, l.scope?.siteName, l.noticeRef, l.officials]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [legalIssues, q, deptFilter])

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filtered)

  const remove = async (row) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${row.title}?`)) return
    try {
      await deleteLegalIssue(row.id, row.title, actor)
      toast.success('Deleted')
    } catch (e) {
      toastCaught(e)
    }
  }

  return (
    <>
      <PageHeader
        title="Legal Issues"
        subtitle={`${legalIssues.length} logged`}
        actions={isManager && <Button icon={Plus} onClick={() => navigate('/stakeholder/legal/new')}>Log legal issue</Button>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Filter by department">
          <option value="">All departments</option>
          {DEPARTMENTS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </Select>
        <Input
          className="ml-auto max-w-xs"
          placeholder="Search title, notice ref, official…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <SkeletonTable rows={5} />
      ) : !filtered.length ? (
        <EmptyState
          icon={Gavel}
          title={q || deptFilter ? 'Nothing matches' : 'No legal issues logged'}
          hint={q || deptFilter ? 'Clear the filters to see everything.' : 'Record a department visit or a notice served, including visits that produced nothing — that is the evidence an inspection happened and passed.'}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-3 py-2">Ref</th>
                <th className="px-3 py-2">Matter</th>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2">Department</th>
                <th className="px-3 py-2">Notice</th>
                <th className="px-3 py-2">From complaint</th>
                <th className="px-3 py-2">Status</th>
                {isManager && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((row) => {
                const notice = NOTICE_BY_KEY[row.noticeType]
                return (
                  <tr key={row.id} className="border-t border-ink-100">
                    <td className="px-3 py-2 font-mono text-xs">{row.docId || '—'}</td>
                    <td className="px-3 py-2 font-medium text-ink-800">{row.title}</td>
                    <td className="px-3 py-2">{row.scope?.siteName || '—'}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {(row.departments || []).slice(0, 2).map((d) => (
                          <Badge key={d} tone="slate">{DEPARTMENT_BY_KEY[d]?.label || d}</Badge>
                        ))}
                        {(row.departments || []).length > 2 && (
                          <span className="text-xs text-ink-400">+{row.departments.length - 2}</span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={notice?.tone || 'slate'}>{notice?.label || row.noticeType}</Badge>
                      {row.noticeRef && <div className="mt-0.5 font-mono text-[11px] text-ink-400">{row.noticeRef}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.escalation ? (
                        <span className="text-ink-600">{row.escalation.docId || row.escalation.title}</span>
                      ) : row.brokenLink ? (
                        // "No complaint" and "the complaint was deleted" are
                        // different facts and must not look the same.
                        <span className="flex items-center gap-1 text-amber-700" title="The linked escalation no longer exists">
                          <Link2Off size={12} /> deleted
                        </span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={LEGAL_STATUS_BY_KEY[row.status]?.tone || 'slate'}>
                        {LEGAL_STATUS_BY_KEY[row.status]?.label || row.status}
                      </Badge>
                    </td>
                    {isManager && (
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" className="px-2 py-1 text-xs" icon={Pencil} onClick={() => navigate(`/stakeholder/legal/${row.id}`)} />
                          <Button variant="ghost" className="px-2 py-1 text-xs" icon={Trash2} onClick={() => remove(row)} />
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
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
