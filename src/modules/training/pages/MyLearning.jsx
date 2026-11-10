import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  BookOpenCheck, GraduationCap, Link2, Paperclip, CheckCircle2, CalendarClock, BadgeCheck, Award,
  Video, MapPin, ExternalLink,
} from 'lucide-react'
import { PageHeader, Card, Badge, Button, EmptyState, SkeletonCard, Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { formatDate, daysUntil } from '../../../shared/lib/format'
import { useTraining } from '../context/TrainingContext'
import {
  selfCompleteTraining, subscribeSessions, subscribeRequests, requestSession, withdrawRequest,
} from '../lib/data'
import { isClassroom, sortSessions, sessionState, canRequest, sessionWhere } from '../lib/sessions'
import { assignmentStatus, ASSIGNMENT_META, recordStatus, STATUS_META, todayISO } from '../lib/status'
import CertificateModal from '../components/Certificate'
import CourseThumb from '../components/CourseThumb'
import { safeHref } from '../../../shared/safeUrl'

/** Learning material chips for a course (links open, files download). */
function ContentList({ course }) {
  const items = course?.content || []
  if (!items.length) return <p className="text-xs italic text-ink-400">No learning material attached — complete this as instructed by your trainer.</p>
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((c) => (
        <a
          key={c.id}
          href={safeHref(c.type === 'file' ? (c.dataUrl || c.url) : c.url)}
          target="_blank"
          rel="noreferrer"
          download={c.type === 'file' ? c.fileName || c.label : undefined}
          className="chip bg-brand-50 text-brand-700 transition hover:bg-brand-100"
        >
          {c.type === 'file' ? <Paperclip size={12} /> : <Link2 size={12} />} {c.label}
        </a>
      ))}
    </div>
  )
}

const STATE_LABEL = { open: 'Running now', upcoming: 'Upcoming', closed: 'Finished' }

/**
 * The sittings of one classroom course, with the ask-for-a-place action.
 *
 * Finished sittings are shown greyed rather than hidden: an employee looking at
 * a course needs to see it has run before, otherwise an empty card reads as
 * "this training does not exist" when it simply is not scheduled right now.
 */
function SessionPicker({ course, sessions, requests, sites, busyId, onRequest, onWithdraw }) {
  if (sessions.length === 0) {
    return (
      <div className="my-3 rounded-2xl bg-surface-50 px-3.5 py-3 text-xs leading-relaxed text-ink-500 shadow-elev-sm">
        <span className="font-semibold text-ink-700">Classroom training.</span> No sittings are scheduled
        yet — it will appear here when a date is set.
      </div>
    )
  }
  return (
    <div className="my-3 flex flex-col gap-2">
      {sessions.map((s) => {
        const st = sessionState(s)
        // `requests` is already this person's, so the session is the only key.
        const mine = requests.find((r) => r.sessionId === s.id) || null
        const closed = st === 'closed'
        return (
          <div key={s.id} className={`rounded-2xl px-3.5 py-3 shadow-elev-sm ${closed ? 'bg-surface-100/60' : 'bg-surface-50'}`}>
            <div className="flex items-center gap-2">
              {s.mode === 'online' ? <Video size={13} className="text-ink-400" /> : <MapPin size={13} className="text-ink-400" />}
              <span className={`text-xs font-semibold ${closed ? 'text-ink-400' : 'text-ink-800'}`}>
                {sessionWhere(s, sites)}
              </span>
              <Badge tone={st === 'open' ? 'green' : st === 'upcoming' ? 'blue' : 'gray'} className="ml-auto shrink-0 !py-0 text-[10px]">
                {STATE_LABEL[st]}
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{s.validFrom} → {s.validTo}{s.trainerName ? ` · ${s.trainerName}` : ''}</p>

            {/* The link only helps once a place is confirmed. */}
            {s.mode === 'online' && s.meetingLink && mine?.status === 'approved' && (
              <a href={safeHref(s.meetingLink)} target="_blank" rel="noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:underline">
                <ExternalLink size={11} /> Join link
              </a>
            )}

            <div className="mt-2">
              {mine ? (
                <div className="flex items-center gap-2">
                  <Badge tone={mine.status === 'approved' ? 'green' : mine.status === 'declined' ? 'red' : 'amber'} className="!py-0 text-[10px]">
                    {mine.status === 'approved' ? 'Place confirmed' : mine.status === 'declined' ? 'Not this time' : 'Requested'}
                  </Badge>
                  {mine.status === 'pending' && (
                    <button type="button" onClick={() => onWithdraw(mine)}
                      className="text-[11px] font-semibold text-ink-400 hover:text-red-600">
                      Withdraw
                    </button>
                  )}
                </div>
              ) : canRequest(s) ? (
                <Button variant="soft" className="!px-3 !py-1.5 !text-xs"
                  loading={busyId === `req-${s.id}`} onClick={() => onRequest({ ...s, courseName: course.name })}>
                  Request a place
                </Button>
              ) : (
                <span className="text-[11px] text-ink-400">This sitting has finished.</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function MyLearning() {
  const { orgName, profile, actor } = useAuth()
  const { loading, courses, myAssignments, myRecords } = useTraining()
  const [busyId, setBusyId] = useState(null)
  const [certRecord, setCertRecord] = useState(null)
  const today = todayISO()

  // Classroom sittings and my own requests for them.
  const sites = useAccessibleSites()
  const [sessions, setSessions] = useState([])
  const [requests, setRequests] = useState([])
  useEffect(() => {
    const unsubs = [subscribeSessions(setSessions), subscribeRequests(setRequests)]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  const myRequests = useMemo(
    () => requests.filter((r) => r.employeeUid === profile?.uid),
    [requests, profile]
  )
  const sessionsFor = (courseId) => sortSessions(sessions.filter((s) => s.courseId === courseId))

  const request = async (session) => {
    setBusyId(`req-${session.id}`)
    try {
      await requestSession({ session, profile }, actor)
      toast.success('Requested — your trainer will confirm your place')
    } catch (e) {
      toastCaught(e, 'Could not send the request')
    } finally { setBusyId(null) }
  }

  const withdraw = async (req) => {
    setBusyId(`req-${req.sessionId}`)
    try {
      await withdrawRequest(req.id, actor, req.courseName)
      toast.success('Request withdrawn')
    } catch (e) {
      toastCaught(e, 'Could not withdraw')
    } finally { setBusyId(null) }
  }

  // Courses not currently assigned to me — the browsable catalogue.
  const availableCourses = courses.filter((c) => !myAssignments.some((a) => a.courseId === c.id))

  // The catalogue and the certification history grow independently, so each
  // pages on its own number. "Assigned to me" is deliberately left whole — it is
  // a short open-task list, not a register.
  const catalogue = usePagination(availableCourses)
  const records = usePagination(myRecords)

  // Self-complete a course directly from the catalogue (no assignment needed).
  const completeCourse = async (course) => {
    setBusyId(`course-${course.id}`)
    try {
      const ids = myAssignments.filter((a) => a.courseId === course.id).map((a) => a.id)
      await selfCompleteTraining({ course, profile, assignmentIds: ids }, actor)
      toast.success(`"${course.name}" marked completed`)
    } catch (e) {
      toastCaught(e, 'Could not complete the training')
    } finally {
      setBusyId(null)
    }
  }

  const complete = async (assignment) => {
    const course = courses.find((c) => c.id === assignment.courseId)
    if (!course) return toast.error('Course no longer exists — ask an admin')
    setBusyId(assignment.id)
    try {
      // Close every open assignment of mine for this course in the same batch.
      const ids = myAssignments.filter((a) => a.courseId === course.id).map((a) => a.id)
      await selfCompleteTraining({ course, profile, assignmentIds: ids }, actor)
      toast.success(`"${course.name}" marked completed`)
    } catch (e) {
      toastCaught(e, 'Could not complete the training')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="My Learning" subtitle="Your assigned trainings and certifications" icon={BookOpenCheck} />
        <SkeletonCard className="max-w-3xl" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="My Learning"
        subtitle={`${profile?.name ? profile.name.split(' ')[0] + ' — ' : ''}your assigned trainings and certifications`}
        icon={BookOpenCheck}
      />

      {/* Assigned to me */}
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-800">
        <CalendarClock size={17} className="text-brand-600" /> Assigned to me ({myAssignments.length})
      </h3>
      {myAssignments.length === 0 ? (
        <Card className="mb-6">
          <EmptyState icon={CheckCircle2} title="Nothing assigned" description="You're all caught up — assigned trainings will appear here." />
        </Card>
      ) : (
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          {myAssignments.map((a) => {
            const st = assignmentStatus(a.dueDate, today)
            const meta = ASSIGNMENT_META[st]
            const course = courses.find((c) => c.id === a.courseId)
            const d = daysUntil(a.dueDate)
            return (
              <Card key={a.id} className="!p-4" style={{ boxShadow: `inset 4px 0 0 ${meta.color}` }}>
                <CourseThumb course={course || { category: a.category }} className="mb-3" />
                <div className="mb-1.5 flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold text-ink-900">{a.courseName}</p>
                    <p className="text-xs text-ink-500">{a.category || course?.category || ''}{a.assignedByName ? ` · assigned by ${a.assignedByName}` : ''}</p>
                  </div>
                  <Badge tone={meta.tone}>
                    {a.dueDate ? <>Due {formatDate(a.dueDate)}{d != null && d < 0 ? ` · ${Math.abs(d)}d overdue` : ''}</> : meta.label}
                  </Badge>
                </div>
                <div className="mb-4 mt-3">
                  <ContentList course={course} />
                </div>
                <Button icon={CheckCircle2} loading={busyId === a.id} onClick={() => complete(a)}>
                  Mark completed
                </Button>
              </Card>
            )
          })}
        </div>
      )}

      {/* Available trainings (full catalogue, YouTube-style) */}
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-800">
        <GraduationCap size={17} className="text-brand-600" /> Available trainings ({availableCourses.length})
      </h3>
      {availableCourses.length === 0 ? (
        <Card className="mb-6">
          <EmptyState icon={GraduationCap} title="No other courses" description="Every catalogue course is already assigned to you." />
        </Card>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {catalogue.pageItems.map((c) => (
            <Card key={c.id} className="flex flex-col !p-4">
              <CourseThumb course={c} className="mb-3" />
              <div className="mb-1 flex items-start justify-between gap-2">
                <p className="font-bold leading-snug text-ink-900">{c.name}</p>
                {c.mandatory && <Badge tone="red" className="shrink-0 !py-0 text-[10px]">Mandatory</Badge>}
              </div>
              <p className="text-xs text-ink-500">{c.category || 'Other'} · {c.validityMonths ? `${c.validityMonths}m validity` : 'no expiry'}</p>
              {isClassroom(c) ? (
                /* A classroom course is not something you can simply mark done —
                   it happens at a time and a place, so the only action is to ask
                   for a place at one of its sittings. */
                <SessionPicker
                  course={c}
                  sessions={sessionsFor(c.id)}
                  requests={myRequests}
                  sites={sites}
                  busyId={busyId}
                  onRequest={request}
                  onWithdraw={withdraw}
                />
              ) : (
                <>
                  <div className="my-3"><ContentList course={c} /></div>
                  <div className="mt-auto">
                    <Button variant="soft" icon={CheckCircle2} loading={busyId === `course-${c.id}`} onClick={() => completeCourse(c)}>
                      Complete training
                    </Button>
                  </div>
                </>
              )}
            </Card>
          ))}
          <Pager
            className="col-span-full border-t border-surface-200/60 px-1 pt-3"
            page={catalogue.page} pageCount={catalogue.pageCount} onPage={catalogue.setPage}
            total={catalogue.total} pageSize={catalogue.pageSize}
          />
        </div>
      )}

      {/* My certifications */}
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-ink-800">
        <BadgeCheck size={17} className="text-green-600" /> My certifications ({myRecords.length})
      </h3>
      {myRecords.length === 0 ? (
        <Card>
          <EmptyState icon={GraduationCap} title="No trainings recorded yet" description="Completed trainings and their expiry dates will show here." />
        </Card>
      ) : (
        <Card className="overflow-hidden !p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3">Course</th>
                  <th className="px-4 py-3">Completed</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Certificate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {records.pageItems.map((r) => {
                  const st = recordStatus(r.expiresOn, today)
                  return (
                    <tr key={r.id} className="hover:bg-surface-100/50">
                      <td className="px-4 py-3">
                        <span className="font-semibold text-ink-900">{r.courseName}</span>
                        {r.loggedBy === 'self' && <span className="ml-2 text-[10px] font-semibold uppercase text-ink-400">Self-declared</span>}
                      </td>
                      <td className="px-4 py-3 text-ink-700">{formatDate(r.completedOn)}</td>
                      <td className="px-4 py-3 text-ink-700">{r.expiresOn ? formatDate(r.expiresOn) : '—'}</td>
                      <td className="px-4 py-3"><Badge tone={STATUS_META[st].tone}>{STATUS_META[st].label}</Badge></td>
                      <td className="px-4 py-3 text-right">
                        <button className="btn-ghost px-2.5 py-1.5 text-xs text-amber-600" title="View certificate" onClick={() => setCertRecord(r)}>
                          <Award size={14} /> View
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-surface-200/60 px-4 py-3"
            page={records.page} pageCount={records.pageCount} onPage={records.setPage}
            total={records.total} pageSize={records.pageSize}
          />
        </Card>
      )}

      <CertificateModal record={certRecord} orgName={orgName} onClose={() => setCertRecord(null)} />
    </>
  )
}
