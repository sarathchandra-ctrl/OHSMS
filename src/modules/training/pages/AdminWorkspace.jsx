import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  ClipboardList, CalendarPlus, Search, ChevronDown, ChevronUp, X, UsersRound, CheckCircle2, AlertTriangle,
} from 'lucide-react'
import { PageHeader, Card, Field, Input, Select, Button, Badge, StatCard, EmptyState, SkeletonCard } from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { orgDepartments } from '../../../shared/auth/access'
import { formatDate } from '../../../shared/lib/format'
import { useTraining } from '../context/TrainingContext'
import { assignCourse, cancelAssignment, cancelAssignmentsBulk } from '../lib/firestore'
import { assignmentStatus, ASSIGNMENT_META, todayISO } from '../lib/status'
import EmployeeChips from '../components/EmployeeChips'

const createdMs = (a) => (a?.createdAt?.toMillis ? a.createdAt.toMillis() : 0)

function itemBadge(a, today) {
  if (a.status === 'completed') return <Badge tone="green">Completed{a.completedOn ? ` ${formatDate(a.completedOn)}` : ''}</Badge>
  const st = assignmentStatus(a.dueDate, today)
  return <Badge tone={ASSIGNMENT_META[st].tone}>{ASSIGNMENT_META[st].label}</Badge>
}

export default function AdminWorkspace() {
  const { actor, isManager, org } = useAuth()
  const { loading, courses, users, assignments, openAssignments, siteInventory } = useTraining()
  const today = todayISO()

  // ── Assign panel state ──
  const [form, setForm] = useState({ courseId: '', dueDate: '' })
  const [mode, setMode] = useState('department')
  const [value, setValue] = useState('')
  const [picked, setPicked] = useState([])
  const [empSearch, setEmpSearch] = useState('')
  const [busy, setBusy] = useState(false)

  // ── Register state ──
  const [f, setF] = useState({ courseId: 'all', status: 'active', q: '' })
  const [expanded, setExpanded] = useState(null) // campaign key
  const [itemSearch, setItemSearch] = useState('')
  const [busyKey, setBusyKey] = useState(null)

  const deptOptions = useMemo(
    () => [...new Set([...orgDepartments(org), ...users.map((u) => u.department || u.dept).filter(Boolean)])].sort(),
    [org, users]
  )
  const entityOptions = useMemo(() => [...new Set(siteInventory.map((s) => s.entity).filter(Boolean))].sort(), [siteInventory])
  const regionOptions = useMemo(() => [...new Set(siteInventory.map((s) => s.region).filter(Boolean))].sort(), [siteInventory])

  const groupLabel = useMemo(() => {
    if (mode === 'people') return 'Individual selection'
    if (!value) return ''
    if (mode === 'department') return `Department: ${value}`
    if (mode === 'site') return `Site: ${siteInventory.find((s) => s.id === value)?.name || value}`
    if (mode === 'entity') return `Entity: ${value}`
    if (mode === 'region') return `Region: ${value}`
    return ''
  }, [mode, value, siteInventory])

  const targets = useMemo(() => {
    if (mode === 'people') return users.filter((u) => picked.includes(u.uid))
    if (!value) return []
    if (mode === 'department') return users.filter((u) => (u.department || u.dept) === value)
    if (mode === 'site') return users.filter((u) => u.siteId === value || u.access?.sites?.includes(value))
    if (mode === 'entity') return users.filter((u) => u.access?.entities?.includes(value))
    if (mode === 'region') return users.filter((u) => u.access?.regions?.includes(value))
    return []
  }, [mode, value, users, picked])

  const doAssign = async (e) => {
    e.preventDefault()
    const course = courses.find((c) => c.id === form.courseId)
    if (!course) return toast.error('Pick a course')
    if (targets.length === 0) return toast.error(mode === 'people' ? 'Pick at least one employee' : 'Pick a group with at least one employee')
    if (!form.dueDate) return toast.error('Pick a due date')
    setBusy(true)
    try {
      const res = await assignCourse(
        { course, employees: targets, dueDate: form.dueDate, group: { mode, label: groupLabel } },
        actor,
        openAssignments,
      )
      toast.success(`Assigned to ${res.assigned} employee${res.assigned === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} already assigned)` : ''}`)
      setValue('')
      setPicked([])
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setBusy(false)
    }
  }

  // ── Campaigns: one row per assignment batch ──
  const campaigns = useMemo(() => {
    const map = new Map()
    for (const a of assignments) {
      if (a.status === 'cancelled') continue
      const key = a.batchId || `legacy|${a.courseId}|${a.dueDate}|${a.groupLabel || ''}`
      if (!map.has(key)) {
        map.set(key, {
          key,
          courseName: a.courseName,
          courseId: a.courseId,
          groupLabel: a.groupLabel || 'Individual selection',
          dueDate: a.dueDate || '',
          assignedByName: a.assignedByName || '',
          createdMs: createdMs(a),
          items: [],
        })
      }
      const c = map.get(key)
      c.items.push(a)
      c.createdMs = Math.max(c.createdMs, createdMs(a))
    }
    return [...map.values()]
      .map((c) => {
        const open = c.items.filter((a) => a.status === 'assigned')
        const completed = c.items.filter((a) => a.status === 'completed')
        const overdue = open.filter((a) => assignmentStatus(a.dueDate, today) === 'overdue')
        return {
          ...c,
          total: c.items.length,
          open: open.length,
          completed: completed.length,
          overdue: overdue.length,
          openIds: open.map((a) => a.id),
          pct: c.items.length ? Math.round((completed.length / c.items.length) * 100) : 0,
        }
      })
      .sort((a, b) => b.createdMs - a.createdMs)
  }, [assignments, today])

  const shownCampaigns = useMemo(
    () =>
      campaigns
        .filter((c) => (f.courseId === 'all' ? true : c.courseId === f.courseId))
        .filter((c) => (f.status === 'all' ? true : f.status === 'active' ? c.open > 0 : c.open === 0))
        .filter((c) => (f.q ? `${c.courseName} ${c.groupLabel} ${c.assignedByName}`.toLowerCase().includes(f.q.toLowerCase()) : true)),
    [campaigns, f],
  )

  const totals = useMemo(
    () => ({
      campaigns: campaigns.length,
      open: campaigns.reduce((n, c) => n + c.open, 0),
      overdue: campaigns.reduce((n, c) => n + c.overdue, 0),
      completed: campaigns.reduce((n, c) => n + c.completed, 0),
    }),
    [campaigns],
  )

  const cancelCampaign = async (c) => {
    if (!window.confirm(`Cancel ${c.open} open assignment(s) for "${c.courseName}" (${c.groupLabel})?`)) return
    setBusyKey(c.key)
    try {
      await cancelAssignmentsBulk(c.openIds, actor, `${c.courseName} — ${c.groupLabel}`)
      toast.success(`${c.openIds.length} assignment(s) cancelled`)
    } catch (e) {
      toastCaught(e, 'Failed')
    } finally {
      setBusyKey(null)
    }
  }

  const cancelOne = async (a) => {
    setBusyKey(a.id)
    try {
      await cancelAssignment(a.id, actor, `${a.courseName} · ${a.employeeName}`)
      toast.success('Assignment cancelled')
    } catch (e) {
      toastCaught(e, 'Failed')
    } finally {
      setBusyKey(null)
    }
  }

  if (!isManager) return <Navigate to="/training" replace />

  if (loading) {
    return (
      <>
        <PageHeader title="Admin Workspace" subtitle="Assign trainings to groups and track every campaign" icon={ClipboardList} />
        <SkeletonCard className="max-w-3xl" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Admin Workspace"
        subtitle="Assign trainings to a department, site, entity or region — then track completion per campaign"
        icon={ClipboardList}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Campaigns" value={totals.campaigns} icon={ClipboardList} tone="brand" />
        <StatCard label="Open assignments" value={totals.open} icon={UsersRound} tone="amber" />
        <StatCard label="Overdue" value={totals.overdue} icon={AlertTriangle} tone="red" />
        <StatCard label="Completed" value={totals.completed} icon={CheckCircle2} tone="green" />
      </div>

      {/* ── Assign training ── */}
      <Card className="mb-6">
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-800">
          <CalendarPlus size={17} className="text-brand-600" /> Assign training
        </h3>
        <form onSubmit={doAssign} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Course *">
              <Select value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}>
                <option value="">Select course…</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Assign to *">
              <Select value={mode} onChange={(e) => { setMode(e.target.value); setValue('') }}>
                <option value="department">Everyone in a department</option>
                <option value="site">Everyone at a site</option>
                <option value="entity">Everyone in an entity</option>
                <option value="region">Everyone in a region</option>
                <option value="people">Specific employees</option>
              </Select>
            </Field>
            {mode !== 'people' && (
              <Field label={mode === 'department' ? 'Department *' : mode === 'site' ? 'Site *' : mode === 'entity' ? 'Entity *' : 'Region *'}>
                <Select value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Select…</option>
                  {mode === 'department' && deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                  {mode === 'site' && siteInventory.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {mode === 'entity' && entityOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                  {mode === 'region' && regionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Due date *">
              <Input type="date" min={todayISO()} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </Field>
          </div>

          {mode === 'people' ? (
            <EmployeeChips users={users} picked={picked} onToggle={(uid) => setPicked((p) => (p.includes(uid) ? p.filter((x) => x !== uid) : [...p, uid]))} search={empSearch} setSearch={setEmpSearch} label="Employees *" />
          ) : (
            <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50 px-3.5 py-2.5 text-sm text-ink-700 ">
              {value
                ? <><b>{targets.length}</b> employee{targets.length === 1 ? '' : 's'} in <b>{groupLabel}</b> will be assigned — anyone with this course already open is skipped.</>
                : 'Pick a group to see how many employees it covers.'}
            </div>
          )}

          <div className="flex justify-end">
            <Button type="submit" loading={busy} icon={CalendarPlus}>
              Assign to {targets.length || '…'} employee{targets.length === 1 ? '' : 's'}
            </Button>
          </div>
        </form>
      </Card>

      {/* ── Campaign register ── */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="input pl-9" placeholder="Search course, group, assigner…" value={f.q} onChange={(e) => setF((p) => ({ ...p, q: e.target.value }))} />
          </div>
          <Select className="!w-auto" value={f.courseId} onChange={(e) => setF((p) => ({ ...p, courseId: e.target.value }))}>
            <option value="all">All courses</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select className="!w-auto" value={f.status} onChange={(e) => setF((p) => ({ ...p, status: e.target.value }))}>
            <option value="active">Active campaigns</option>
            <option value="done">Fully completed</option>
            <option value="all">All</option>
          </Select>
        </div>
      </Card>

      {shownCampaigns.length === 0 ? (
        <EmptyState icon={ClipboardList} title={campaigns.length ? 'No matching campaigns' : 'No assignments yet'}
          description={campaigns.length ? 'Try different filters.' : 'Assign a training above — each batch becomes a trackable campaign here.'} />
      ) : (
        <div className="space-y-3">
          {shownCampaigns.map((c) => {
            const isOpen = expanded === c.key
            const items = isOpen
              ? c.items
                  .filter((a) => (itemSearch ? a.employeeName.toLowerCase().includes(itemSearch.toLowerCase()) : true))
                  .slice(0, 100)
              : []
            return (
              <Card key={c.key} className="!p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold text-ink-900">{c.courseName}</p>
                      <Badge tone="brand">{c.groupLabel}</Badge>
                      {c.dueDate && <Badge tone={c.overdue ? 'red' : 'gray'}>Due {formatDate(c.dueDate)}</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {c.total} assigned{c.assignedByName ? ` by ${c.assignedByName}` : ''} · {c.completed} completed · {c.open} open{c.overdue ? ` (${c.overdue} overdue)` : ''}
                    </p>
                  </div>
                  <div className="flex w-40 items-center gap-2">
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-200">
                      <div className="h-full rounded-full transition-all" style={{ width: `${c.pct}%`, backgroundColor: c.pct >= 90 ? '#16a34a' : c.pct >= 50 ? '#d97706' : '#dc2626' }} />
                    </div>
                    <span className="text-xs font-bold text-ink-700">{c.pct}%</span>
                  </div>
                  {c.open > 0 && (
                    <button className="btn-ghost px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50" disabled={busyKey === c.key}
                      onClick={() => cancelCampaign(c)} title="Cancel every open assignment in this campaign">
                      <X size={14} /> Cancel open ({c.open})
                    </button>
                  )}
                  <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => { setExpanded(isOpen ? null : c.key); setItemSearch('') }}>
                    {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {isOpen ? 'Hide' : 'Details'}
                  </button>
                </div>

                {isOpen && (
                  <div className="mt-3 border-t border-surface-200/60 pt-3">
                    <input className="input mb-2 !w-64 !py-1.5 !text-xs" placeholder="Search assignees…" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} />
                    <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {items.map((a) => (
                        <li key={a.id} className="ring-1 ring-ink-200 flex items-center gap-2 rounded-xl bg-surface-50 px-3 py-1.5 text-sm ">
                          <span className="min-w-0 flex-1 truncate text-ink-800">{a.employeeName}</span>
                          {itemBadge(a, today)}
                          {a.status === 'assigned' && (
                            <button className="text-ink-300 hover:text-red-600" disabled={busyKey === a.id} onClick={() => cancelOne(a)} title="Cancel this assignment">
                              <X size={13} />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {c.items.length > 100 && (
                      <p className="mt-2 text-xs italic text-ink-400">Showing first 100 — search to narrow.</p>
                    )}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
