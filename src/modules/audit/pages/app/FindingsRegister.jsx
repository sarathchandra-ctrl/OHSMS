import { useEffect, useMemo, useState } from 'react'
import { Search, AlertTriangle } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { subscribeAuditFindings } from '../../services/auditModule'
import PageHeader from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Badge from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import { Pager } from '../../../../shared/ui'
import { usePagination } from '../../../../shared/ui/usePagination'

const TYPE_TONE = { 'Major NC': 'red', 'Minor NC': 'amber', OFI: 'blue', Observation: 'slate' }
const RECORD_TONE = { Reported: 'red', 'Submitted for Verification': 'amber', Closed: 'green' }
const RECORD_LABEL = {
  Reported: 'Open',
  'Submitted for Verification': 'In Verification',
  Closed: 'Closed',
}

export default function FindingsRegister() {
  const { org } = useAuth()
  const [records, setRecords] = useState([])
  const [filters, setFilters] = useState({ q: '', type: '', status: '' })

  useEffect(() => {
    return subscribeAuditFindings(setRecords)
  }, [])

  const rows = useMemo(() => {
    const out = []
    records.forEach((r) => {
      (r.findings || []).forEach((f) => {
        out.push({
          ...f,
          auditDocId: r.docId,
          site: r.taskDetails?.siteId,
          dept: r.taskDetails?.dept,
          area: r.taskDetails?.area,
          auditor: r.auditor || r.taskDetails?.auditor,
          auditee: r.taskDetails?.auditee,
          date: (r.auditDate || '').split('T')[0],
          recordStatus: r.status,
          hasCapa: f.response?.status === 'Completed',
        })
      })
    })
    return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [records])

  const filtered = rows
    .filter((r) => (filters.type ? r.type === filters.type : true))
    .filter((r) => (filters.status ? r.recordStatus === filters.status : true))
    .filter((r) =>
      filters.q
        ? `${r.desc} ${r.clause} ${r.id} ${r.dept} ${r.area}`
            .toLowerCase()
            .includes(filters.q.toLowerCase())
        : true,
    )

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filtered)

  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div>
      <PageHeader
        title="Findings"
        subtitle="Every finding raised across audits. Raised in the Auditor Workplace — view only here."
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input icon={Search} placeholder="Search findings…" value={filters.q} onChange={setF('q')} />
        <Select value={filters.type} onChange={setF('type')}>
          <option value="">All types</option>
          <option value="Observation">Observation</option>
          <option value="OFI">OFI</option>
          <option value="Minor NC">Minor NC</option>
          <option value="Major NC">Major NC</option>
        </Select>
        <Select value={filters.status} onChange={setF('status')}>
          <option value="">All statuses</option>
          <option value="Reported">Open</option>
          <option value="Submitted for Verification">In Verification</option>
          <option value="Closed">Closed</option>
        </Select>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title="No findings yet"
          message="Findings raised by auditors during an audit will appear here."
        />
      ) : filtered.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-slate-400">No findings match your filters.</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto !p-0">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-widest text-slate-500">
              <tr>
                <th className="px-5 py-3">ID</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Clause</th>
                <th className="px-3 py-3">Finding</th>
                <th className="px-3 py-3">Site / Dept</th>
                <th className="px-3 py-3">Auditee</th>
                <th className="px-3 py-3">Raised</th>
                <th className="px-3 py-3">CAPA</th>
                <th className="px-3 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageItems.map((r, i) => (
                <tr key={`${r.auditDocId}-${r.id}-${i}`} className="hover:bg-slate-50/60">
                  <td className="px-5 py-3 font-mono text-xs font-bold text-brand-600">{r.id}</td>
                  <td className="px-3 py-3"><Badge tone={TYPE_TONE[r.type] || 'slate'}>{r.type}</Badge></td>
                  <td className="px-3 py-3 text-slate-500">{r.clause || '—'}</td>
                  <td className="max-w-xs px-3 py-3"><span className="block truncate text-ink-800">{r.desc}</span></td>
                  <td className="px-3 py-3 text-slate-500">{r.site || '—'}{r.dept ? ` · ${r.dept}` : ''}</td>
                  <td className="px-3 py-3 text-slate-500">{r.auditee || '—'}</td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-500">{r.date || '—'}</td>
                  <td className="px-3 py-3">{r.hasCapa ? <Badge tone="green">Provided</Badge> : <Badge tone="slate">Pending</Badge>}</td>
                  <td className="px-3 py-3"><Badge tone={RECORD_TONE[r.recordStatus] || 'slate'}>{RECORD_LABEL[r.recordStatus] || r.recordStatus}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            className="border-t border-slate-100 px-5 py-3"
            page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize}
          />
        </Card>
      )}
    </div>
  )
}
