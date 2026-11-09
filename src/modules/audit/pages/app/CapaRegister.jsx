import { useEffect, useMemo, useState } from 'react'
import { isOverdueDate } from '../../../../shared/lib/dates'
import { Search, Wrench, Download } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { subscribeAuditFindings } from '../../services/auditModule'
import PageHeader from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Badge from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import { safeHref } from '../../../../shared/safeUrl'

const TYPE_TONE = { 'Major NC': 'red', 'Minor NC': 'amber', OFI: 'blue', Observation: 'slate' }
// A CAPA is verified once its audit record is Closed; otherwise it's open/awaiting verification.
const capaState = (recordStatus) =>
  recordStatus === 'Closed'
    ? ['green', 'Verified']
    : recordStatus === 'Submitted for Verification'
      ? ['amber', 'In Verification']
      : ['blue', 'Open']

// Through the shared helper, which compares YYYY-MM-DD strings. new
// Date(target) reads a date-only string as UTC midnight, so a CAPA due TODAY
// showed as overdue from 05:30 that morning in IST — on the working day it was
// still due.
const isOverdue = (target, verified) => isOverdueDate(target, { closed: verified })

export default function CapaRegister() {
  const { org } = useAuth()
  const [records, setRecords] = useState([])
  const [filters, setFilters] = useState({ q: '', state: '' })

  useEffect(() => {
    return subscribeAuditFindings(setRecords)
  }, [])

  const rows = useMemo(() => {
    const out = []
    records.forEach((r) => {
      (r.findings || []).forEach((f) => {
        if (f.response?.status !== 'Completed') return
        const [tone, label] = capaState(r.status)
        out.push({
          findingId: f.id,
          type: f.type,
          action: f.response.capa,
          rootCause: f.response.rootCause,
          owner: f.response.owner,
          targetDate: f.response.targetDate,
          evidenceFile: f.response.evidenceFile,
          evidenceFileName: f.response.evidenceFileName,
          auditDocId: r.docId,
          site: r.taskDetails?.siteId,
          tone,
          label,
          verified: r.status === 'Closed',
        })
      })
    })
    return out.sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || ''))
  }, [records])

  const filtered = rows
    .filter((r) => (filters.state ? r.label === filters.state : true))
    .filter((r) =>
      filters.q
        ? `${r.action} ${r.rootCause} ${r.owner} ${r.findingId}`
            .toLowerCase()
            .includes(filters.q.toLowerCase())
        : true,
    )

  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div>
      <PageHeader
        title="CAPA"
        subtitle="Corrective & preventive actions. Provided by the auditee in the Auditee Workplace — view only here."
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input icon={Search} placeholder="Search CAPA…" value={filters.q} onChange={setF('q')} />
        <Select value={filters.state} onChange={setF('state')}>
          <option value="">All states</option>
          <option value="Open">Open</option>
          <option value="In Verification">In Verification</option>
          <option value="Verified">Verified</option>
        </Select>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No corrective actions yet"
          message="When an auditee responds to a finding with a CAPA, it will appear here."
        />
      ) : filtered.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-slate-400">No CAPA match your filters.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((r, i) => {
            const overdue = isOverdue(r.targetDate, r.verified)
            return (
              <Card key={`${r.auditDocId}-${r.findingId}-${i}`} className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs font-bold text-slate-600">{r.findingId}</span>
                    <Badge tone={TYPE_TONE[r.type] || 'slate'}>{r.type}</Badge>
                    <Badge tone={r.tone}>{r.label}</Badge>
                    {overdue && <Badge tone="red">Overdue</Badge>}
                  </div>
                  <p className="flex items-start gap-2 text-sm font-medium text-ink-800">
                    <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                    {r.action}
                  </p>
                  {r.rootCause && (
                    <p className="mt-1 text-xs text-slate-400">
                      <span className="font-semibold">Root cause:</span> {r.rootCause}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-5 text-right text-xs">
                  <div>
                    <span className="block uppercase tracking-widest text-slate-400">Owner</span>
                    <span className="font-bold text-ink-800">{r.owner || '—'}</span>
                  </div>
                  <div>
                    <span className="block uppercase tracking-widest text-slate-400">Target</span>
                    <span className={`font-mono ${overdue ? 'font-bold text-rose-600' : 'text-ink-800'}`}>{r.targetDate || '—'}</span>
                  </div>
                  {r.evidenceFileName && (
                    <a
                      href={safeHref(r.evidenceFile)}
                      download={r.evidenceFileName}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 font-bold text-emerald-600 transition active:scale-[0.97] hover:bg-emerald-600 hover:text-white"
                    >
                      <Download className="h-3.5 w-3.5" /> Evidence
                    </a>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
