import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { GraduationCap, BadgeCheck, Clock3, AlertTriangle, BookOpen, ArrowRight, CalendarClock } from 'lucide-react'
import { PageHeader, Card, StatCard, EmptyState, Badge, Select, SkeletonCard } from '../../../shared/ui'
import { formatDate, daysUntil } from '../../../shared/lib/format'
import { useAuth } from '../../../shared/auth/AuthContext'
import { orgDepartments } from '../../../shared/auth/access'
import { useTraining } from '../context/TrainingContext'
import { recordStatus, latestByEmployeeCourse, STATUS_META, assignmentStatus, summarize, summarizeAssignments, todayISO } from '../lib/status'

export default function Dashboard() {
  const { org } = useAuth()
  const { loading, courses, records, users, openAssignments } = useTraining()
  const today = todayISO()

  // Every stat on this dashboard can be scoped to a single course AND/OR department.
  const [courseFilter, setCourseFilter] = useState('all')
  const [deptFilter, setDeptFilter] = useState('all')

  const uidDept = useMemo(() => {
    const m = new Map()
    for (const u of users) m.set(u.uid, u.department || u.dept || 'Unassigned')
    return m
  }, [users])
  const deptOptions = useMemo(
    () => [...new Set([...orgDepartments(org), ...uidDept.values()])].sort(),
    [org, uidDept]
  )

  const fUsers = useMemo(
    () => (deptFilter === 'all' ? users : users.filter((u) => (u.department || u.dept || 'Unassigned') === deptFilter)),
    [users, deptFilter]
  )
  const fRecords = useMemo(
    () =>
      records
        .filter((r) => (courseFilter === 'all' ? true : r.courseId === courseFilter))
        .filter((r) => (deptFilter === 'all' ? true : uidDept.get(r.employeeUid) === deptFilter)),
    [records, courseFilter, deptFilter, uidDept]
  )
  const fOpenAssignments = useMemo(
    () =>
      openAssignments
        .filter((a) => (courseFilter === 'all' ? true : a.courseId === courseFilter))
        .filter((a) => (deptFilter === 'all' ? true : uidDept.get(a.employeeUid) === deptFilter)),
    [openAssignments, courseFilter, deptFilter, uidDept]
  )
  const stats = useMemo(() => summarize(fRecords, today), [fRecords, today])
  const assignmentStats = useMemo(() => summarizeAssignments(fOpenAssignments, today), [fOpenAssignments, today])

  // Course-scoped (but NOT department-scoped) sets feed the department breakdown,
  // so the segregation always shows every department side by side.
  const cRecords = useMemo(
    () => (courseFilter === 'all' ? records : records.filter((r) => r.courseId === courseFilter)),
    [records, courseFilter]
  )
  const cOpenAssignments = useMemo(
    () => (courseFilter === 'all' ? openAssignments : openAssignments.filter((a) => a.courseId === courseFilter)),
    [openAssignments, courseFilter]
  )
  // Department-scoped (but NOT course-scoped) records feed the course-coverage list.
  const dRecords = useMemo(
    () => (deptFilter === 'all' ? records : records.filter((r) => uidDept.get(r.employeeUid) === deptFilter)),
    [records, deptFilter, uidDept]
  )

  // Department-wise segregation: per department — current certification counts,
  // open/overdue assignments and compliance (mandatory courses, or the selected
  // course when the course filter is active).
  const deptBreakdown = useMemo(() => {
    const scopeIds = courseFilter === 'all' ? courses.filter((c) => c.mandatory).map((c) => c.id) : [courseFilter]
    const latest = latestByEmployeeCourse(cRecords)
    const map = new Map()
    const get = (d) => {
      if (!map.has(d)) map.set(d, { name: d, employees: 0, valid: 0, expiring: 0, expired: 0, open: 0, overdue: 0, covered: 0 })
      return map.get(d)
    }
    for (const u of users) {
      const row = get(u.department || u.dept || 'Unassigned')
      row.employees += 1
      for (const cid of scopeIds) {
        const r = latest.get(`${u.uid}:${cid}`)
        if (r && recordStatus(r.expiresOn, today) !== 'expired') row.covered += 1
      }
    }
    for (const rec of latest.values()) {
      const row = get(uidDept.get(rec.employeeUid) || 'Unassigned')
      const st = recordStatus(rec.expiresOn, today)
      if (st === 'expired') row.expired += 1
      else if (st === 'expiring') row.expiring += 1
      else row.valid += 1
    }
    for (const a of cOpenAssignments) {
      const row = get(uidDept.get(a.employeeUid) || 'Unassigned')
      row.open += 1
      if (assignmentStatus(a.dueDate, today) === 'overdue') row.overdue += 1
    }
    return [...map.values()]
      .map((r) => ({
        ...r,
        // No course in scope (none marked mandatory) is not 100% compliant:
        // it is nothing measured. It showed a full green bar beside overdue work.
        pct: r.employees && scopeIds.length ? Math.round((r.covered / (r.employees * scopeIds.length)) * 100) : null,
      }))
      .sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101) || b.employees - a.employees)
  }, [users, cRecords, cOpenAssignments, courses, courseFilter, uidDept, today])

  // Open assignments already past their due date — the LMS chase list.
  const overdueAssignments = useMemo(
    () =>
      fOpenAssignments
        .filter((a) => assignmentStatus(a.dueDate, today) === 'overdue')
        .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
        .slice(0, 8),
    [fOpenAssignments, today]
  )

  // Current certifications only (each employee's latest record per course).
  const current = useMemo(() => [...latestByEmployeeCourse(fRecords).values()], [fRecords])

  const attention = useMemo(
    () =>
      current
        .filter((r) => ['expired', 'expiring'].includes(recordStatus(r.expiresOn, today)))
        .sort((a, b) => (a.expiresOn || '').localeCompare(b.expiresOn || ''))
        .slice(0, 12),
    [current, today]
  )

  // Per-course compliance across approved employees (mandatory courses first).
  const byCourse = useMemo(() => {
    const latest = latestByEmployeeCourse(dRecords)
    return courses
      .map((c) => {
        const holders = fUsers.filter((u) => {
          const r = latest.get(`${u.uid}:${c.id}`)
          return r && recordStatus(r.expiresOn, today) !== 'expired'
        }).length
        const pct = fUsers.length ? Math.round((holders / fUsers.length) * 100) : 0
        return { ...c, holders, pct }
      })
      .sort((a, b) => (b.mandatory ? 1 : 0) - (a.mandatory ? 1 : 0) || a.name.localeCompare(b.name))
  }, [courses, dRecords, fUsers, today])

  if (loading) {
    return (
      <>
        <PageHeader title="Training Dashboard" subtitle="Certification health across your workforce" icon={GraduationCap} />
        <SkeletonCard className="max-w-3xl" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Training Dashboard"
        subtitle="Certification health across your workforce"
        icon={GraduationCap}
        actions={
          <div className="flex flex-wrap gap-2">
            <Select className="!w-auto" value={courseFilter} onChange={(e) => setCourseFilter(e.target.value)} title="Scope every stat to one course">
              <option value="all">All courses</option>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select className="!w-auto" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} title="Scope every stat to one department">
              <option value="all">All departments</option>
              {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </Select>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Courses" value={courseFilter === 'all' ? courses.length : 1} icon={BookOpen} tone="brand" />
        <StatCard label="Records" value={stats.total} icon={GraduationCap} tone="brand" />
        <StatCard label="Valid" value={stats.valid} icon={BadgeCheck} tone="green" />
        <StatCard label="Expiring ≤30d" value={stats.expiring} icon={Clock3} tone="amber" />
        <StatCard label="Expired" value={stats.expired} icon={AlertTriangle} tone="red" />
        <StatCard label="Open assignments" value={assignmentStats.open} icon={CalendarClock} tone="brand" />
        <StatCard label="Due ≤7d" value={assignmentStats.due_soon} icon={Clock3} tone="amber" />
        <StatCard label="Assignments overdue" value={assignmentStats.overdue} icon={AlertTriangle} tone="red" />
      </div>

      {/* Department-wise segregation */}
      <Card className="mb-6 overflow-hidden !p-0">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h3 className="flex items-center gap-2 font-semibold text-ink-800">
            <BadgeCheck size={17} className="text-brand-600" /> Department breakdown
            {courseFilter !== 'all' && (
              <Badge tone="brand">{courses.find((c) => c.id === courseFilter)?.name}</Badge>
            )}
          </h3>
          <p className="text-xs text-ink-400">
            Compliance = {courseFilter === 'all' ? 'mandatory courses' : 'selected course'} · click a row to focus
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-5 py-2.5">Department</th>
                <th className="px-4 py-2.5 text-center">Employees</th>
                <th className="px-4 py-2.5 text-center">Valid</th>
                <th className="px-4 py-2.5 text-center">Expiring</th>
                <th className="px-4 py-2.5 text-center">Expired</th>
                <th className="px-4 py-2.5 text-center">Open assignments</th>
                <th className="px-4 py-2.5">Compliance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-200/60">
              {deptBreakdown.map((d) => (
                <tr
                  key={d.name}
                  onClick={() => setDeptFilter(deptFilter === d.name ? 'all' : d.name)}
                  className={`cursor-pointer hover:bg-surface-100/50 ${deptFilter === d.name ? 'bg-brand-50/60' : ''}`}
                  title={deptFilter === d.name ? 'Click to clear the department focus' : 'Click to scope the dashboard to this department'}
                >
                  <td className="px-5 py-2.5 font-semibold text-ink-800">{d.name}</td>
                  <td className="px-4 py-2.5 text-center text-ink-700">{d.employees}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-green-700">{d.valid || '—'}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-amber-600">{d.expiring || '—'}</td>
                  <td className="px-4 py-2.5 text-center font-semibold text-red-600">{d.expired || '—'}</td>
                  <td className="px-4 py-2.5 text-center">
                    {d.open ? (
                      <span className={d.overdue ? 'font-bold text-red-600' : 'text-ink-700'}>
                        {d.open}{d.overdue ? ` (${d.overdue} overdue)` : ''}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {d.pct == null ? (
                      <span className="text-xs text-ink-500">No mandatory course</span>
                    ) : (
                    <div className="flex items-center gap-2">
                      {/* A bare div conveys a percentage by width alone. role="progressbar"
                          plus the value attributes is what makes the same figure
                          available to anyone not looking at the pixels. */}
                      <div className="h-2.5 w-28 overflow-hidden rounded-full bg-surface-200" role="progressbar" aria-valuenow={d.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${d.name || 'Department'} training completion`}>
                        <div className="h-full rounded-full" style={{ width: `${d.pct}%`, backgroundColor: d.pct >= 90 ? '#16a34a' : d.pct >= 60 ? '#d97706' : '#dc2626' }} />
                      </div>
                      <span className="text-xs font-semibold text-ink-600">{d.pct}%</span>
                    </div>
                    )}
                  </td>
                </tr>
              ))}
              {deptBreakdown.length === 0 && (
                <tr><td colSpan="7" className="px-5 py-8 text-center text-sm italic text-ink-400">No employees yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Needs attention */}
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <AlertTriangle size={17} className="text-amber-600" /> Needs attention
            </h3>
            <Link to="/training/records" className="text-xs font-semibold text-brand-600 hover:underline">
              All records <ArrowRight size={12} className="inline" />
            </Link>
          </div>
          {overdueAssignments.length > 0 && (
            <ul className="mb-3 divide-y divide-surface-200/60 border-b border-surface-200/60 pb-2">
              {overdueAssignments.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-800">{a.employeeName}</p>
                    <p className="truncate text-xs text-ink-500">{a.courseName} · assignment not completed</p>
                  </div>
                  <Badge tone="red">Due {formatDate(a.dueDate)}</Badge>
                </li>
              ))}
            </ul>
          )}
          {attention.length === 0 && overdueAssignments.length === 0 ? (
            <EmptyState icon={BadgeCheck} title="Nothing needs attention" description="No overdue assignments, and no certifications expired or due within 30 days." />
          ) : (
            <ul className="divide-y divide-surface-200/60">
              {attention.map((r) => {
                const st = recordStatus(r.expiresOn, today)
                const d = daysUntil(r.expiresOn)
                return (
                  <li key={r.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink-800">{r.employeeName}</p>
                      <p className="truncate text-xs text-ink-500">{r.courseName}{r.site ? ` · ${r.site}` : ''}</p>
                    </div>
                    <Badge tone={STATUS_META[st].tone}>
                      {formatDate(r.expiresOn)}{d != null && (d < 0 ? ` · ${Math.abs(d)}d overdue` : ` · ${d}d left`)}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {/* Course coverage */}
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <BookOpen size={17} className="text-brand-600" /> Course coverage
            </h3>
            <Link to="/training/employees" className="text-xs font-semibold text-brand-600 hover:underline">
              Employee status <ArrowRight size={12} className="inline" />
            </Link>
          </div>
          {byCourse.length === 0 ? (
            <EmptyState icon={BookOpen} title="No courses yet" description="Define your course catalogue to start tracking certifications." />
          ) : (
            <ul className="space-y-3">
              {byCourse.slice(0, 8).map((c) => (
                <li key={c.id}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-ink-800">
                      {c.name} {c.mandatory && <Badge tone="red" className="ml-1 !py-0 text-[10px]">Mandatory</Badge>}
                    </span>
                    <span className="text-xs text-ink-500">{c.holders}/{users.length} · {c.pct}%</span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-200">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${c.pct}%`, backgroundColor: c.pct >= 90 ? '#16a34a' : c.pct >= 60 ? '#d97706' : '#dc2626' }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
