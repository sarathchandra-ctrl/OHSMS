// ─────────────────────────────────────────────────────────────────────────────
// Training → Quiz → one quiz's results. Who answered, when (date and time),
// their score, and every answer they gave, marked right or wrong; exported to
// CSV or Excel with a column per question. Managers only (stack/policy.mjs).
// ─────────────────────────────────────────────────────────────────────────────
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, Award, CheckCircle2, ChevronDown, ChevronRight, FileSpreadsheet, FileText, ListChecks, XCircle,
} from 'lucide-react'
import { PageHeader, Button, IconButton, Badge, EmptyState, SkeletonTable, Field, Input, Select } from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { formatDateTime } from '../../../shared/lib/format'
import QuizCertificate from '../components/QuizCertificate'
import {
  QUIZ_PASS_PERCENT, downloadQuizCsv, downloadQuizExcel, responseAnswers, subscribeQuizzes, subscribeResponsesForQuiz,
} from '../lib/quizzes'

function Stat({ label, value }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-0.5 text-xl font-bold text-ink-900">{value}</p>
    </div>
  )
}

export default function QuizResponses() {
  const { id } = useParams()
  const { isManager } = useAuth()
  const [quizzes, setQuizzes] = useState(null)
  const [responses, setResponses] = useState(null)
  const [open, setOpen] = useState(() => new Set())
  const [outcome, setOutcome] = useState('all')
  const [q, setQ] = useState('')
  const [certificate, setCertificate] = useState(null)

  useEffect(() => subscribeQuizzes(setQuizzes), [])
  useEffect(() => subscribeResponsesForQuiz(id, setResponses), [id])

  const quiz = useMemo(() => (quizzes || []).find((x) => x.id === id) || null, [quizzes, id])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (responses || []).filter((r) => {
      if (outcome === 'pass' && !r.passed) return false
      if (outcome === 'fail' && r.passed) return false
      return !needle || [r.name, r.employeeId, r.centerName].join(' ').toLowerCase().includes(needle)
    })
  }, [responses, outcome, q])

  if (!isManager) return <EmptyState icon={ListChecks} title="Quiz results are for managers" />
  if (quizzes === null || responses === null) return <SkeletonTable rows={5} />
  // A deleted quiz's responses stay; its title comes from them.
  const title = quiz?.title || responses[0]?.quizTitle || 'Quiz'
  const passed = (responses || []).filter((r) => r.passed).length
  const average = responses.length ? Math.round(responses.reduce((n, r) => n + (r.percent || 0), 0) / responses.length) : 0
  const toggle = (rid) => setOpen((s) => { const n = new Set(s); n.has(rid) ? n.delete(rid) : n.add(rid); return n })
  const exportWith = (fn) => async () => {
    try { await fn(quiz || { title, questions: [] }, shown) } catch (err) { toastCaught(err, 'Could not export') }
  }

  return (
    <div>
      <Link to="/training/quiz" className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700">
        <ArrowLeft size={15} /> All quizzes
      </Link>
      <PageHeader
        icon={ListChecks}
        title={`${title} — results`}
        subtitle={`Every response from this quiz's QR code, with each person's answers. ${QUIZ_PASS_PERCENT}% or more passes.`}
        actions={
          <div className="flex gap-2">
            <Button variant="soft" icon={FileText} onClick={exportWith(downloadQuizCsv)} disabled={!shown.length}>Export CSV</Button>
            <Button variant="soft" icon={FileSpreadsheet} onClick={exportWith(downloadQuizExcel)} disabled={!shown.length}>Export Excel</Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Responses" value={responses.length} />
        <Stat label="Passed" value={passed} />
        <Stat label="Not passed" value={responses.length - passed} />
        <Stat label="Average score" value={`${average}%`} />
      </div>

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Result">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="all">Pass and fail</option>
            <option value="pass">Passed</option>
            <option value="fail">Did not pass</option>
          </Select>
        </Field>
        <Field label="Search">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, employee ID or centre" />
        </Field>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={ListChecks} title="No responses yet" description="They appear here as people submit the quiz from its QR code." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="px-3 py-2"><span className="sr-only">Show answers</span></th>
                <th className="px-3 py-2">Submitted</th>
                <th className="px-3 py-2">Employee ID</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Centre</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Result</th>
                <th className="px-3 py-2"><span className="sr-only">Certificate</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open.has(r.id)
                return (
                  <Fragment key={r.id}>
                    <tr className="border-t border-ink-100">
                      <td className="px-3 py-2">
                        <IconButton icon={isOpen ? ChevronDown : ChevronRight} size="sm"
                          label={`${isOpen ? 'Hide' : 'Show'} ${r.name}’s answers`} aria-expanded={isOpen}
                          onClick={() => toggle(r.id)} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-ink-600">{formatDateTime(r.submittedAt)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.employeeId}</td>
                      <td className="px-3 py-2 font-semibold text-ink-900">{r.name}</td>
                      <td className="px-3 py-2">{r.centerName}</td>
                      <td className="px-3 py-2">{r.score}/{r.total} ({r.percent}%)</td>
                      <td className="px-3 py-2"><Badge tone={r.passed ? 'green' : 'red'}>{r.passed ? 'Passed' : 'Not passed'}</Badge></td>
                      <td className="px-3 py-2">
                        {r.passed && <IconButton icon={Award} size="sm" label={`Certificate for ${r.name}`} onClick={() => setCertificate(r)} />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-surface-50" aria-label={`${r.name}’s answers`}>
                        <td colSpan={8} className="pb-3 pl-14 pr-3 pt-1">
                          <ol className="space-y-1.5">
                            {responseAnswers(r, quiz).map((a, i) => (
                              <li key={i} className="flex items-start gap-2">
                                {a.correct
                                  ? <CheckCircle2 size={16} className="mt-0.5 flex-none text-emerald-600" aria-label="Correct" />
                                  : <XCircle size={16} className="mt-0.5 flex-none text-red-600" aria-label="Wrong" />}
                                <span>
                                  <span className="text-ink-500">Q{i + 1}. {a.question}</span>{' '}
                                  <b className="text-ink-900">{a.chosen || '—'}</b>
                                </span>
                              </li>
                            ))}
                          </ol>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {certificate && <QuizCertificate result={certificate} onClose={() => setCertificate(null)} />}
    </div>
  )
}
