import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { GraduationCap, Plus, Trash2, Search, RotateCcw, CalendarPlus, Award } from 'lucide-react'
import { PageHeader, Card, Field, Input, Select, Button, Modal, Badge, EmptyState, SkeletonTable, Pager } from '../../../shared/ui'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import { useAuth } from '../../../shared/auth/AuthContext'
import { formatDate, daysUntil } from '../../../shared/lib/format'
import { useTraining } from '../context/TrainingContext'
import { logTraining, deleteRecord } from '../lib/data'
import { recordStatus, STATUS_META, todayISO } from '../lib/status'
import CertificateModal from '../components/Certificate'
import EmployeeChips from '../components/EmployeeChips'

const EMPTY = { courseId: '', trainerName: '', completedOn: todayISO(), notes: '', region: '', entity: '', siteId: '', site: '' }

export default function Records() {
  const { orgName, actor, isManager } = useAuth()
  const [certRecord, setCertRecord] = useState(null)
  const { loading, courses, records, users, siteInventory, openAssignments } = useTraining()
  const today = todayISO()

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [picked, setPicked] = useState([]) // employee uids
  const [empSearch, setEmpSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ q: '', courseId: 'all', status: 'all' })

  // Group / bulk assignment lives in the Admin Workspace (/training/admin).

  const openLog = (courseId = '', employeeUid = '') => {
    setForm({ ...EMPTY, completedOn: todayISO(), courseId: courseId || courses[0]?.id || '' })
    setPicked(employeeUid ? [employeeUid] : [])
    setEmpSearch('')
    setOpen(true)
  }

  const toggleEmp = (uid) => setPicked((p) => (p.includes(uid) ? p.filter((x) => x !== uid) : [...p, uid]))

  const save = async (e) => {
    e.preventDefault()
    const course = courses.find((c) => c.id === form.courseId)
    if (!course) return toast.error('Pick a course')
    if (picked.length === 0) return toast.error('Pick at least one employee')
    if (!form.completedOn) return toast.error('Pick the completion date')
    setBusy(true)
    try {
      const employees = users.filter((u) => picked.includes(u.uid))
      const n = await logTraining({
        course, employees,
        trainerName: form.trainerName,
        completedOn: form.completedOn,
        scope: { region: form.region, entity: form.entity, siteId: form.siteId, site: form.site },
        notes: form.notes,
      }, actor, openAssignments)
      toast.success(`Logged for ${n} employee${n === 1 ? '' : 's'}`)
      setOpen(false)
    } catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  const remove = async (r) => {
    if (!window.confirm(`Delete ${r.employeeName}'s "${r.courseName}" record?`)) return
    try { await deleteRecord(r.id, actor, `${r.courseName} · ${r.employeeName}`); toast.success('Record deleted') }
    catch (err) { toastCaught(err, 'Failed') }
  }

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase()
    return records
      .filter((r) => (f.courseId === 'all' ? true : r.courseId === f.courseId))
      .filter((r) => (f.status === 'all' ? true : recordStatus(r.expiresOn, today) === f.status))
      .filter((r) => (q ? `${r.employeeName} ${r.courseName} ${r.trainerName} ${r.site}`.toLowerCase().includes(q) : true))
  }, [records, f, today])

  // Pagination — keeps the table light with thousands of records.
  const RECORDS_PAGE = 50
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [f])
  const pageCount = Math.max(1, Math.ceil(filtered.length / RECORDS_PAGE))
  const safePage = Math.min(page, pageCount)
  const pageItems = filtered.slice((safePage - 1) * RECORDS_PAGE, safePage * RECORDS_PAGE)

  return (
    <>
      <PageHeader
        title="Training Records"
        subtitle="Every completed training, with automatic expiry from the course validity"
        icon={GraduationCap}
        actions={
          <div className="flex gap-2">
            {isManager && (
              <Link to="/training/admin" className="btn-soft">
                <CalendarPlus size={16} /> Assign course
              </Link>
            )}
            <Button icon={Plus} onClick={() => openLog()} disabled={courses.length === 0}>Log training</Button>
          </div>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="input pl-9" placeholder="Search employee, course, trainer…" value={f.q}
              onChange={(e) => setF((p) => ({ ...p, q: e.target.value }))} />
          </div>
          <Select className="!w-auto" value={f.courseId} onChange={(e) => setF((p) => ({ ...p, courseId: e.target.value }))}>
            <option value="all">All courses</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select className="!w-auto" value={f.status} onChange={(e) => setF((p) => ({ ...p, status: e.target.value }))}>
            <option value="all">All statuses</option>
            <option value="valid">Valid</option>
            <option value="expiring">Expiring ≤30d</option>
            <option value="expired">Expired</option>
            <option value="none">No expiry</option>
          </Select>
        </div>
      </Card>

      {loading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title={records.length ? 'No matching records' : 'No training logged yet'}
          description={records.length ? 'Try adjusting the filters above.' : courses.length ? 'Log your first training session.' : 'Add courses to the catalogue first, then log trainings against them.'}
        />
      ) : (
        <Card className="overflow-hidden !p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Course</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Completed</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((r) => {
                  const st = recordStatus(r.expiresOn, today)
                  const d = daysUntil(r.expiresOn)
                  return (
                    <tr key={r.id} className="hover:bg-surface-100/50" style={{ boxShadow: `inset 4px 0 0 ${STATUS_META[st].color}` }}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-ink-900">{r.employeeName}</p>
                        {r.trainerName && <p className="text-xs text-ink-400">Trainer: {r.trainerName}</p>}
                      </td>
                      <td className="px-4 py-3 text-ink-700">
                        {r.courseName}
                        {r.category && <p className="text-xs text-ink-400">{r.category}</p>}
                      </td>
                      <td className="px-4 py-3 text-ink-700">{r.site || <span className="text-ink-300">—</span>}</td>
                      <td className="px-4 py-3 text-ink-700">{formatDate(r.completedOn)}</td>
                      <td className="px-4 py-3 text-ink-700">
                        {r.expiresOn ? (
                          <>
                            {formatDate(r.expiresOn)}
                            {d != null && <span className={`ml-1 text-xs ${d < 0 ? 'text-red-600 font-semibold' : 'text-ink-400'}`}>{d < 0 ? `${Math.abs(d)}d overdue` : `${d}d`}</span>}
                          </>
                        ) : <span className="text-ink-300">—</span>}
                      </td>
                      <td className="px-4 py-3"><Badge tone={STATUS_META[st].tone}>{STATUS_META[st].label}</Badge></td>
                      <td className="px-4 py-3 text-right">
                        <button className="btn-ghost px-2.5 py-1.5 text-xs text-amber-600" title="View certificate"
                          onClick={() => setCertRecord(r)}>
                          <Award size={14} />
                        </button>
                        {['expired', 'expiring'].includes(st) && (
                          <button className="btn-ghost px-2.5 py-1.5 text-xs text-brand-700" title="Log refresher (renew)"
                            onClick={() => openLog(r.courseId, r.employeeUid)}>
                            <RotateCcw size={14} /> Renew
                          </button>
                        )}
                        {isManager && (
                          <button className="btn-ghost px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50" title="Delete" onClick={() => remove(r)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager className="border-t border-surface-200/60 px-4 py-3" page={safePage} pageCount={pageCount} onPage={setPage} total={filtered.length} pageSize={RECORDS_PAGE} />
        </Card>
      )}

      {/* Log training */}
      <Modal open={open} onClose={() => setOpen(false)} title="Log training" size="lg">
        <form onSubmit={save} className="space-y-4 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Course *" htmlFor="rcourse">
              <Select id="rcourse" value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.validityMonths ? ` (${c.validityMonths}m validity)` : ''}</option>
                ))}
              </Select>
            </Field>
            <Field label="Completion date *" htmlFor="rdate">
              <Input id="rdate" type="date" max={todayISO()} value={form.completedOn}
                onChange={(e) => setForm({ ...form, completedOn: e.target.value })} />
            </Field>
          </div>

          <EmployeeChips
            users={users}
            picked={picked}
            onToggle={toggleEmp}
            search={empSearch}
            setSearch={setEmpSearch}
            label="Employees *"
          />

          <Field label="Site scope">
            <SiteScopePicker
              module="training"
              sites={siteInventory}
              value={form}
              onChange={(v) => setForm((p) => ({ ...p, ...v }))}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trainer (optional)" htmlFor="rtrainer">
              <Input id="rtrainer" value={form.trainerName} placeholder="e.g. Acme Fire Academy"
                onChange={(e) => setForm({ ...form, trainerName: e.target.value })} />
            </Field>
            <Field label="Notes (optional)" htmlFor="rnotes">
              <Input id="rnotes" value={form.notes} placeholder="e.g. Practical assessment passed"
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>
              {picked.length > 1 ? `Log for ${picked.length} employees` : 'Log training'}
            </Button>
          </div>
        </form>
      </Modal>

      <CertificateModal record={certRecord} orgName={orgName} onClose={() => setCertRecord(null)} />
    </>
  )
}
