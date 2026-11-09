// ─────────────────────────────────────────────────────────────────────────────
// Classroom sessions.
//
// A course says what is taught; a session says when and where. Only classroom
// courses appear here — module-based training is always open, so it has nothing
// to schedule and nobody to admit.
//
// Requests live alongside the session rather than in a queue of their own,
// because the decision an admin is making is "should I run this sitting", and
// that is answered by seeing who has asked next to the date and the room.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  CalendarClock, Plus, Pencil, Trash2, Video, MapPin, Users, Check, X, ExternalLink,
} from 'lucide-react'
import {
  PageHeader, Field, Input, Select, Textarea, Button, Modal, Badge, EmptyState, SkeletonTable,
} from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { useTraining } from '../context/TrainingContext'
import {
  subscribeSessions, subscribeRequests, createSession, updateSession, deleteSession, decideRequest,
} from '../lib/firestore'
import {
  SESSION_MODES, sessionProblems, sessionState, sortSessions, countRequests, sessionWhere, isClassroom,
} from '../lib/sessions'
import { safeHref } from '../../../shared/safeUrl'

const EMPTY = {
  courseId: '', mode: 'online', meetingLink: '', siteId: '', room: '',
  validFrom: '', validTo: '', trainerName: '', seats: 0, notes: '',
}

const STATE_TONE = { open: 'green', upcoming: 'blue', closed: 'gray' }
const STATE_LABEL = { open: 'Open now', upcoming: 'Upcoming', closed: 'Finished' }

export default function Sessions() {
  const { actor, isManager } = useAuth()
  const { courses, loading } = useTraining()
  const sites = useAccessibleSites()

  const [sessions, setSessions] = useState([])
  const [requests, setRequests] = useState([])
  const [editing, setEditing] = useState(null) // 'new' | session | null
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [openRequests, setOpenRequests] = useState(null) // session id

  useEffect(() => {
    const unsubs = [subscribeSessions(setSessions), subscribeRequests(setRequests)]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  const classroomCourses = useMemo(() => courses.filter(isClassroom), [courses])
  const rows = useMemo(() => sortSessions(sessions), [sessions])
  const counts = useMemo(() => countRequests(requests), [requests])

  const openNew = () => {
    setForm({ ...EMPTY, courseId: classroomCourses[0]?.id || '' })
    setEditing('new')
  }
  const openEdit = (s) => {
    setForm({
      courseId: s.courseId, mode: s.mode || 'online', meetingLink: s.meetingLink || '',
      siteId: s.siteId || '', room: s.room || '', validFrom: s.validFrom || '', validTo: s.validTo || '',
      trainerName: s.trainerName || '', seats: s.seats || 0, notes: s.notes || '',
    })
    setEditing(s)
  }

  const save = async (e) => {
    e.preventDefault()
    const course = courses.find((c) => c.id === form.courseId)
    if (!course) return toast.error('Pick the course this session teaches')
    const problems = sessionProblems(form)
    if (problems.length) return toast.error(problems[0])
    setBusy(true)
    try {
      const site = sites.find((s) => s.id === form.siteId)
      const payload = { ...form, courseName: course.name, siteName: site?.name || '' }
      if (editing === 'new') { await createSession(payload, actor); toast.success('Session scheduled') }
      else { await updateSession(editing.id, payload, actor); toast.success('Session updated') }
      setEditing(null)
    } catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  const remove = async (s) => {
    const n = counts.get(s.id)?.total || 0
    if (!window.confirm(`Delete this session for "${s.courseName}"?${n ? ` ${n} request(s) will be removed with it.` : ''}`)) return
    try { await deleteSession(s.id, actor, s.courseName); toast.success('Session deleted') }
    catch (err) { toastCaught(err, 'Failed') }
  }

  const decide = async (req, status) => {
    try { await decideRequest(req, status, actor); toast.success(status === 'approved' ? 'Approved' : 'Declined') }
    catch (err) { toastCaught(err, 'Failed') }
  }

  const shown = openRequests ? requests.filter((r) => r.sessionId === openRequests) : []

  return (
    <>
      <PageHeader
        title="Classroom Sessions"
        subtitle="Scheduled sittings of classroom courses, and who has asked for a place"
        icon={CalendarClock}
        actions={isManager && classroomCourses.length > 0 && <Button icon={Plus} onClick={openNew}>Schedule session</Button>}
      />

      {loading ? (
        <SkeletonTable rows={4} cols={4} />
      ) : classroomCourses.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No classroom courses yet"
          description="Only courses set to “Classroom session” can be scheduled. Set a course's delivery to classroom in the catalogue, then come back to add its dates."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nothing scheduled"
          description="Add a sitting with its dates and either a meeting link or the site it runs at. Employees can then request a place."
          action={isManager && <Button icon={Plus} onClick={openNew}>Schedule session</Button>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((s) => {
            const st = sessionState(s)
            const c = counts.get(s.id) || { total: 0, pending: 0, approved: 0 }
            return (
              <div key={s.id} className="card p-5">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold leading-snug text-ink-900">{s.courseName}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500">
                      {s.mode === 'online' ? <Video size={13} /> : <MapPin size={13} />}
                      {sessionWhere(s, sites)}
                      {s.trainerName ? ` · ${s.trainerName}` : ''}
                    </p>
                  </div>
                  <Badge tone={STATE_TONE[st]} className="shrink-0">{STATE_LABEL[st]}</Badge>
                </div>

                <p className="text-xs text-ink-400">
                  {s.validFrom} → {s.validTo}{s.seats ? ` · ${s.seats} seats` : ''}
                </p>

                {s.mode === 'online' && s.meetingLink && (
                  <a
                    href={safeHref(s.meetingLink)} target="_blank" rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline"
                  >
                    <ExternalLink size={12} /> Join link
                  </a>
                )}
                {s.notes && <p className="mt-2 text-xs text-ink-500">{s.notes}</p>}

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setOpenRequests(s.id)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-surface-100 px-3 py-1.5 text-xs font-bold text-ink-700"
                  >
                    <Users size={13} /> {c.total} request{c.total === 1 ? '' : 's'}
                  </button>
                  {c.pending > 0 && <Badge tone="amber" className="!py-0 text-[10px]">{c.pending} pending</Badge>}
                  {c.approved > 0 && <Badge tone="green" className="!py-0 text-[10px]">{c.approved} approved</Badge>}
                  {isManager && (
                    <span className="ml-auto flex gap-1">
                      <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => openEdit(s)}><Pencil size={14} /></button>
                      <button className="btn-ghost px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50" onClick={() => remove(s)}><Trash2 size={14} /></button>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Who asked */}
      <Modal open={!!openRequests} onClose={() => setOpenRequests(null)} title="Requests for this session">
        <div className="p-6">
          {shown.length === 0 ? (
            <p className="rounded-2xl bg-surface-50 px-4 py-6 text-center text-sm text-ink-400 shadow-elev-sm">
              Nobody has requested a place yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((r) => (
                <li key={r.id} className="flex items-center gap-3 rounded-2xl bg-surface-50 px-4 py-3 shadow-elev-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900">{r.employeeName}</p>
                    <p className="truncate text-xs text-ink-400">{r.employeeEmail}</p>
                  </div>
                  {r.status === 'pending' ? (
                    <span className="flex flex-none gap-1">
                      <button className="btn bg-green-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110" onClick={() => decide(r, 'approved')}><Check size={14} /></button>
                      <button className="btn-ghost px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50" onClick={() => decide(r, 'declined')}><X size={14} /></button>
                    </span>
                  ) : (
                    <Badge tone={r.status === 'approved' ? 'green' : 'red'} className="shrink-0">{r.status}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Schedule session' : 'Edit session'}>
        <form onSubmit={save} className="space-y-4 p-6">
          <Field label="Course *" htmlFor="scourse">
            <Select id="scourse" value={form.courseId} onChange={(e) => setForm({ ...form, courseId: e.target.value })}>
              <option value="">Select a classroom course…</option>
              {classroomCourses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>

          <Field label="Where does it run?">
            <div className="grid grid-cols-2 gap-2">
              {SESSION_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setForm({ ...form, mode: m.key })}
                  className={`rounded-2xl px-4 py-2.5 text-sm font-semibold transition ${
                    form.mode === m.key ? 'bg-brand-600 text-white shadow-elev-brand' : 'bg-surface text-ink-700 shadow-elev-sm'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </Field>

          {form.mode === 'online' ? (
            <Field label="Meeting link *" htmlFor="slink" hint="Teams, Meet or Zoom — employees join from here">
              <Input id="slink" value={form.meetingLink} placeholder="https://…"
                onChange={(e) => setForm({ ...form, meetingLink: e.target.value })} />
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Site *" htmlFor="ssite">
                <Select id="ssite" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
                  <option value="">Select a site…</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="Room (optional)" htmlFor="sroom">
                <Input id="sroom" value={form.room} placeholder="e.g. Training Room 1"
                  onChange={(e) => setForm({ ...form, room: e.target.value })} />
              </Field>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Valid from *" htmlFor="sfrom">
              <Input id="sfrom" type="date" value={form.validFrom}
                onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
            </Field>
            <Field label="Valid to *" htmlFor="sto">
              <Input id="sto" type="date" value={form.validTo}
                onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trainer (optional)" htmlFor="strainer">
              <Input id="strainer" value={form.trainerName}
                onChange={(e) => setForm({ ...form, trainerName: e.target.value })} />
            </Field>
            <Field label="Seats (optional)" htmlFor="sseats" hint="0 = no limit">
              <Input id="sseats" type="number" min="0" value={form.seats}
                onChange={(e) => setForm({ ...form, seats: e.target.value })} />
            </Field>
          </div>

          <Field label="Notes (optional)" htmlFor="snotes">
            <Textarea id="snotes" rows={2} value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{editing === 'new' ? 'Schedule' : 'Save'}</Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
