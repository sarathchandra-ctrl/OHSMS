// ─────────────────────────────────────────────────────────────────────────────
// Training → Quiz Results. Every response submitted from a quiz's QR code, as
// the server scored it (stack/quiz.mjs): who, which centre, the score, pass or
// fail, and for a pass the certificate. Managers only (stack/policy.mjs).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Award, Download, ListChecks, Search, Trash2 } from 'lucide-react'
import {
  PageHeader, Field, Input, Select, Button, IconButton, Badge, EmptyState, SkeletonTable, Modal,
} from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { formatDateTime } from '../../../shared/lib/format'
import QuizCertificate from '../components/QuizCertificate'
import {
  QUIZ_PASS_PERCENT, deleteQuizResponse, responsesCsv, subscribeQuizResponses, subscribeQuizzes,
} from '../lib/quizzes'

export default function QuizResults() {
  const { actor, isManager } = useAuth()
  const [responses, setResponses] = useState(null)
  const [quizzes, setQuizzes] = useState([])
  const [quizId, setQuizId] = useState('all')
  const [outcome, setOutcome] = useState('all')
  const [q, setQ] = useState('')
  const [certificate, setCertificate] = useState(null)
  const [removing, setRemoving] = useState(null)

  useEffect(() => subscribeQuizResponses(setResponses), [])
  useEffect(() => subscribeQuizzes(setQuizzes), [])

  // Quizzes since deleted still have responses; their titles come from those.
  const quizOptions = useMemo(() => {
    const m = new Map(quizzes.map((x) => [x.id, x.title]))
    for (const r of responses || []) if (!m.has(r.quizId)) m.set(r.quizId, r.quizTitle)
    return [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
  }, [quizzes, responses])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (responses || []).filter((r) => {
      if (quizId !== 'all' && r.quizId !== quizId) return false
      if (outcome === 'pass' && !r.passed) return false
      if (outcome === 'fail' && r.passed) return false
      if (!needle) return true
      return [r.name, r.employeeId, r.centerName, r.quizTitle].join(' ').toLowerCase().includes(needle)
    })
  }, [responses, quizId, outcome, q])

  if (!isManager) {
    return <EmptyState icon={ListChecks} title="Quiz results are for managers" />
  }

  const exportCsv = () => {
    const blob = new Blob([responsesCsv(shown)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `quiz-results-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const passed = shown.filter((r) => r.passed).length

  return (
    <div>
      <PageHeader
        icon={ListChecks}
        title="Quiz Results"
        subtitle={`Every response from a quiz's QR code, scored on the server. ${QUIZ_PASS_PERCENT}% or more passes and earns a certificate.`}
        actions={<Button variant="soft" icon={Download} onClick={exportCsv} disabled={!shown.length}>Export CSV</Button>}
      />

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Quiz">
          <Select value={quizId} onChange={(e) => setQuizId(e.target.value)}>
            <option value="all">All quizzes</option>
            {quizOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </Select>
        </Field>
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

      {responses === null ? (
        <SkeletonTable rows={5} />
      ) : shown.length === 0 ? (
        <EmptyState icon={Search} title="No responses" description="Responses appear here as people submit a quiz from its QR code." />
      ) : (
        <div className="card overflow-x-auto">
          <p className="px-4 pt-3 text-xs text-ink-500">{shown.length} responses · {passed} passed</p>
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="px-4 py-2">Submitted</th>
                <th className="px-4 py-2">Quiz</th>
                <th className="px-4 py-2">Employee ID</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Centre</th>
                <th className="px-4 py-2">Score</th>
                <th className="px-4 py-2">Result</th>
                <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-ink-100">
                  <td className="whitespace-nowrap px-4 py-2 text-ink-600">{formatDateTime(r.submittedAt)}</td>
                  <td className="px-4 py-2">
                    <Link className="font-semibold text-brand-700 hover:underline" to={`/training/quiz/${r.quizId}`}>{r.quizTitle}</Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{r.employeeId}</td>
                  <td className="px-4 py-2 font-semibold text-ink-900">{r.name}</td>
                  <td className="px-4 py-2">{r.centerName}</td>
                  <td className="px-4 py-2">{r.score}/{r.total} ({r.percent}%)</td>
                  <td className="px-4 py-2">
                    <Badge tone={r.passed ? 'green' : 'red'}>{r.passed ? 'Passed' : 'Not passed'}</Badge>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1">
                      {r.passed && (
                        <IconButton icon={Award} label={`Certificate for ${r.name}`} size="sm" onClick={() => setCertificate(r)} />
                      )}
                      <IconButton icon={Trash2} label={`Remove response from ${r.name}`} size="sm" onClick={() => setRemoving(r)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {certificate && <QuizCertificate result={certificate} onClose={() => setCertificate(null)} />}

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Remove this response?" size="sm">
        <p className="text-sm text-ink-600">
          {removing?.name}’s response to “{removing?.quizTitle}” ({removing?.percent}%) is removed for good.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
          <Button variant="danger" onClick={async () => {
            try { await deleteQuizResponse(removing, actor); setRemoving(null) } catch (err) { toastCaught(err) }
          }}>Remove</Button>
        </div>
      </Modal>
    </div>
  )
}
