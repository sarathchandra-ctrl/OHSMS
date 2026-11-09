import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { UsersRound, Search, Download, BadgeCheck, AlertTriangle, CalendarClock, ShieldAlert } from 'lucide-react'
import { PageHeader, Card, Field, Input, Select, Button, Modal, Badge, StatCard, EmptyState, SkeletonTable, Pager } from '../../../shared/ui'
import { formatDate } from '../../../shared/lib/format'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useTraining } from '../context/TrainingContext'
import { fetchAllRecords, fetchAllAssignments } from '../lib/firestore'
import {
  buildMatrix, assignmentStatus,
  buildStatusReport, toCsv, REPORT_COLUMNS, todayISO,
} from '../lib/status'
import { downloadText } from '../../../shared/lib/download'

const CELL_TONE = { valid: 'green', expiring: 'amber', expired: 'red', none: 'green', missing: 'gray' }
const CELL_LABEL = { valid: 'Valid', expiring: 'Expiring soon', expired: 'Expired', none: 'Completed', missing: 'Not trained' }

export default function EmployeeStatus() {
  const { loading, courses, records, users, openAssignments } = useTraining()
  const [exporting, setExporting] = useState(false)
  const today = todayISO()

  const [q, setQ] = useState('')
  const [detail, setDetail] = useState(null) // employee row | null
  const [exportMode, setExportMode] = useState('asof') // 'asof' | 'range'
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(today)

  // Per-employee rollup: course cells + open assignments + mandatory compliance.
  const rows = useMemo(() => {
    const matrix = buildMatrix(users, courses, records, today)
    const mandatoryIds = new Set(courses.filter((c) => c.mandatory).map((c) => c.id))
    return matrix.map((m) => {
      const user = users.find((u) => u.uid === m.uid) || {}
      const counts = { ok: 0, expiring: 0, expired: 0, gaps: 0 }
      for (const cell of m.cells) {
        if (cell.status === 'valid' || cell.status === 'none') counts.ok += 1
        else if (cell.status === 'expiring') counts.expiring += 1
        else if (cell.status === 'expired') counts.expired += 1
        else if (mandatoryIds.has(cell.courseId)) counts.gaps += 1
      }
      const myOpen = openAssignments.filter((a) => a.employeeUid === m.uid)
      const overdue = myOpen.filter((a) => assignmentStatus(a.dueDate, today) === 'overdue').length
      const mandTotal = mandatoryIds.size
      const mandOk = m.cells.filter(
        (c) => mandatoryIds.has(c.courseId) && ['valid', 'expiring', 'none'].includes(c.status),
      ).length
      const pct = mandTotal ? Math.round((mandOk / mandTotal) * 100) : 100
      return {
        ...m,
        department: user.department || user.dept || '',
        counts,
        open: myOpen.length,
        overdue,
        pct,
        attention: counts.expired + counts.gaps + overdue,
      }
    })
  }, [users, courses, records, openAssignments, today])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle ? rows.filter((r) => `${r.name} ${r.department}`.toLowerCase().includes(needle)) : rows
    // Most at-risk first, then by name.
    return [...list].sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name))
  }, [rows, q])

  // Pagination — stays snappy with thousands of employees.
  const PAGE_SIZE = 50
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [q])
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const totals = useMemo(
    () => ({
      employees: rows.length,
      compliant: rows.filter((r) => r.attention === 0).length,
      attention: rows.filter((r) => r.attention > 0).length,
      open: openAssignments.length,
    }),
    [rows, openAssignments],
  )

  // Org-level progress: mandatory compliance + overall coverage + per department.
  const org = useMemo(() => {
    const totalCells = rows.length * courses.length
    let covered = 0
    for (const r of rows) covered += r.counts.ok + r.counts.expiring
    const overallPct = totalCells ? Math.round((covered / totalCells) * 100) : 0
    const mandPct = rows.length ? Math.round(rows.reduce((n, r) => n + r.pct, 0) / rows.length) : 100
    const byDept = new Map()
    for (const r of rows) {
      const d = r.department || 'Unassigned'
      if (!byDept.has(d)) byDept.set(d, [])
      byDept.get(d).push(r.pct)
    }
    const departments = [...byDept.entries()]
      .map(([name, pcts]) => ({ name, n: pcts.length, pct: Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) }))
      .sort((a, b) => a.pct - b.pct)
    return { overallPct, mandPct, departments }
  }, [rows, courses])

  const downloadCsv = async () => {
    if (!to) return toast.error('Pick the report date')
    if (exportMode === 'range' && from && from > to) return toast.error('From date is after the To date')
    setExporting(true)
    try {
      // Reports use the FULL history (the live views are capped for speed).
      const [allRecords, allAssignments] = await Promise.all([fetchAllRecords(), fetchAllAssignments()])
      const report = buildStatusReport(users, courses, allRecords, allAssignments.filter((a) => a.status === 'assigned'), {
        from: exportMode === 'range' ? from : '',
        to,
      })
      if (!report.length) return toast.error('Nothing to export — add employees and courses first')
      const csv = toCsv(report, REPORT_COLUMNS)
      downloadText(csv, exportMode === 'range'
        ? `training-status-${from || 'start'}-to-${to}.csv`
        : `training-status-as-of-${to}.csv`, { bom: false })
      toast.success(`Exported ${report.length} rows (${users.length} employees × ${courses.length} courses)`)
    } catch (e) {
      toastCaught(e, 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Employee Training Status"
        subtitle="Per-employee view of completed, expiring and due trainings — with a full CSV report"
        icon={UsersRound}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Employees" value={totals.employees} icon={UsersRound} tone="brand" />
        <StatCard label="Fully compliant" value={totals.compliant} icon={BadgeCheck} tone="green" />
        <StatCard label="Need attention" value={totals.attention} icon={AlertTriangle} tone="red" />
        <StatCard label="Open assignments" value={totals.open} icon={CalendarClock} tone="amber" />
      </div>

      {/* Org-level training progress */}
      <Card className="mb-4">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-800">
          <BadgeCheck size={17} className="text-brand-600" /> Organization training progress
        </h3>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="font-medium text-ink-700">Mandatory compliance</span>
                <span className="text-lg font-bold text-ink-900">{org.mandPct}%</span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-surface-200">
                <div className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${org.mandPct}%`, backgroundColor: org.mandPct >= 90 ? '#16a34a' : org.mandPct >= 60 ? '#d97706' : '#dc2626' }} />
              </div>
              <p className="mt-1 text-xs text-ink-400">Average mandatory-course compliance across all employees.</p>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="font-medium text-ink-700">Overall course coverage</span>
                <span className="text-lg font-bold text-ink-900">{org.overallPct}%</span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-surface-200">
                <div className="h-full rounded-full bg-brand-500 transition-all duration-300" style={{ width: `${org.overallPct}%` }} />
              </div>
              <p className="mt-1 text-xs text-ink-400">Share of all employee × course combinations currently trained.</p>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">By department</p>
            {org.departments.length === 0 ? (
              <p className="text-sm italic text-ink-400">No employees yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {org.departments.map((d) => (
                  <li key={d.name}>
                    <div className="mb-0.5 flex items-center justify-between text-sm">
                      <span className="text-ink-700">{d.name} <span className="text-xs text-ink-400">({d.n})</span></span>
                      <span className="text-xs font-semibold text-ink-600">{d.pct}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-200">
                      <div className="h-full rounded-full"
                        style={{ width: `${d.pct}%`, backgroundColor: d.pct >= 90 ? '#16a34a' : d.pct >= 60 ? '#d97706' : '#dc2626' }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      {/* CSV report */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Report type">
            <Select className="!w-auto" value={exportMode} onChange={(e) => setExportMode(e.target.value)}>
              <option value="asof">Status as of a date</option>
              <option value="range">Completions in a date range</option>
            </Select>
          </Field>
          {exportMode === 'range' && (
            <Field label="From">
              <Input type="date" className="!w-auto" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </Field>
          )}
          <Field label={exportMode === 'range' ? 'To' : 'As of'}>
            <Input type="date" className="!w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button icon={Download} loading={exporting} onClick={downloadCsv}>Download CSV</Button>
          <p className="mb-2 text-xs text-ink-400">
            Every employee × course — completed or not — with status, dates and open assignments.
          </p>
        </div>
      </Card>

      {/* Search */}
      <Card className="mb-4">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search employee or department…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Card>

      {loading ? (
        <SkeletonTable rows={6} cols={7} />
      ) : shown.length === 0 ? (
        <EmptyState icon={UsersRound} title={rows.length ? 'No matching employees' : 'No employees yet'}
          description={rows.length ? 'Try a different search.' : 'Add employees in the Employees repository.'} />
      ) : (
        <Card className="overflow-hidden !p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3 text-center">Valid</th>
                  <th className="px-4 py-3 text-center">Expiring</th>
                  <th className="px-4 py-3 text-center">Expired</th>
                  <th className="px-4 py-3 text-center">Mandatory gaps</th>
                  <th className="px-4 py-3 text-center">Assignments due</th>
                  <th className="px-4 py-3">Mandatory compliance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((r) => (
                  <tr key={r.uid} className="cursor-pointer hover:bg-surface-100/50" onClick={() => setDetail(r)} title="Click for course-level detail">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-ink-900">{r.name}</p>
                      {r.department && <p className="text-xs text-ink-400">{r.department}</p>}
                    </td>
                    <td className="px-4 py-3 text-center font-semibold text-green-700">{r.counts.ok}</td>
                    <td className="px-4 py-3 text-center font-semibold text-amber-600">{r.counts.expiring || '—'}</td>
                    <td className="px-4 py-3 text-center font-semibold text-red-600">{r.counts.expired || '—'}</td>
                    <td className="px-4 py-3 text-center font-semibold text-red-600">{r.counts.gaps || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      {r.open ? (
                        <span className={r.overdue ? 'font-bold text-red-600' : 'text-ink-700'}>
                          {r.open}{r.overdue ? ` (${r.overdue} overdue)` : ''}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {/* See Dashboard.jsx: width alone is not a value anyone
                            can read but a sighted user. */}
                        <div className="h-2.5 w-28 overflow-hidden rounded-full bg-surface-200" role="progressbar" aria-valuenow={r.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${r.name || 'Employee'} training completion`}>
                          <div className="h-full rounded-full" style={{ width: `${r.pct}%`, backgroundColor: r.pct >= 90 ? '#16a34a' : r.pct >= 60 ? '#d97706' : '#dc2626' }} />
                        </div>
                        <span className="text-xs font-semibold text-ink-600">{r.pct}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager className="border-t border-surface-200/60 px-4 py-3" page={safePage} pageCount={pageCount} onPage={setPage} total={shown.length} pageSize={PAGE_SIZE} />
        </Card>
      )}

      {/* Per-employee course detail */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.name} — training detail` : ''} size="lg">
        {detail && (
          <div className="max-h-[60vh] overflow-y-auto p-6">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="pb-2 pr-3">Course</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Completed</th>
                  <th className="pb-2 pr-3">Expires</th>
                  <th className="pb-2">Assignment due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {detail.cells.map((cell) => {
                  const course = courses.find((c) => c.id === cell.courseId)
                  const asn = openAssignments.find((a) => a.employeeUid === detail.uid && a.courseId === cell.courseId)
                  const overdue = asn && assignmentStatus(asn.dueDate, today) === 'overdue'
                  return (
                    <tr key={cell.courseId}>
                      <td className="py-2.5 pr-3">
                        <span className="font-medium text-ink-800">{course?.name || '—'}</span>
                        {course?.mandatory && <ShieldAlert size={12} className="ml-1 inline text-red-500" title="Mandatory" />}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge tone={CELL_TONE[cell.status]}>{CELL_LABEL[cell.status]}</Badge>
                      </td>
                      <td className="py-2.5 pr-3 text-ink-700">{cell.record ? formatDate(cell.record.completedOn) : '—'}</td>
                      <td className="py-2.5 pr-3 text-ink-700">{cell.record?.expiresOn ? formatDate(cell.record.expiresOn) : '—'}</td>
                      <td className="py-2.5">
                        {asn ? (
                          <span className={overdue ? 'font-semibold text-red-600' : 'text-ink-700'}>
                            {formatDate(asn.dueDate)}{overdue ? ' · overdue' : ''}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </>
  )
}
