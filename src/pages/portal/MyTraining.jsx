// ─────────────────────────────────────────────────────────────────────────────
// My training.
//
// The admin Training module answers "who in the org is overdue?". This answers
// "am I allowed to do my job today?", which is the same data read from the one
// row that belongs to the person looking at it.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import { GraduationCap } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import { subscribeAssignments, subscribeCourses } from '../../modules/training/lib/data'
import { Raised, Inset, PortalHeading, Ring } from './ui'
import { courseProgress } from './myWork'

export default function MyTraining() {
  const { profile } = useAuth()
  const [assignments, setAssignments] = useState([])
  const [courses, setCourses] = useState([])

  useEffect(() => {
    const unsubs = [subscribeAssignments(setAssignments), subscribeCourses(setCourses)]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  const rows = useMemo(
    () => courseProgress(assignments, courses, profile),
    [assignments, courses, profile]
  )
  const outstanding = rows.filter((r) => !r.done).length
  const expiring = rows.filter((r) => r.state === 'expiring' || r.state === 'expired').length

  return (
    <div className="animate-fade-in-up">
      <PortalHeading
        icon={GraduationCap}
        title="My training"
        subtitle={
          outstanding || expiring
            ? `${outstanding} to complete${expiring ? `, ${expiring} needing renewal` : ''}.`
            : 'Certifications tied to your role.'
        }
      />

      {rows.length === 0 ? (
        <Raised className="px-6 py-14 text-center">
          <p className="text-[15px] font-bold text-ink-900">No courses assigned to you</p>
          <p className="mx-auto mt-1.5 max-w-[44ch] text-[13px] leading-relaxed text-ink-500">
            When your manager assigns a course it appears here with its due date, and stays until the
            certificate is in date.
          </p>
        </Raised>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:max-w-md">
            <Inset className="px-4 py-3">
              <p className="text-[26px] font-extrabold leading-none tracking-[-0.03em] text-ink-900">{outstanding}</p>
              <p className="mt-1 text-[11.5px] text-ink-500">still to complete</p>
            </Inset>
            <Inset className="px-4 py-3">
              <p className="text-[26px] font-extrabold leading-none tracking-[-0.03em] text-ink-900">{expiring}</p>
              <p className="mt-1 text-[11.5px] text-ink-500">need renewal</p>
            </Inset>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((c) => (
              <Raised key={c.key} className="flex flex-col gap-4 p-5 transition-transform duration-200 ease-emil hover:-translate-y-1">
                <div className="flex items-start justify-between gap-3">
                  <Ring pct={c.pct} color={c.color} size={52} />
                  <span
                    className="rounded-full px-2.5 py-1 text-[10.5px] font-bold"
                    style={{ background: `${c.color}1f`, color: c.color }}
                  >
                    {c.status}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-[14px] font-bold leading-snug tracking-[-0.01em] text-ink-900">{c.name}</p>
                  <p className="mt-1 text-[11.5px] text-ink-400">
                    {c.category}{c.due ? ` · due ${c.due}` : ''}
                  </p>
                </div>
              </Raised>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
