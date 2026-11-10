// ─────────────────────────────────────────────────────────────────────────────
// Training → Quiz. A manager writes a multiple-choice quiz, marks the right
// option for each question, and prints its QR code. Whoever scans it answers
// on /quiz/:token with their employee ID, name and centre; the server scores
// it (stack/quiz.mjs) and the result appears under Quiz Results. 80% or more
// earns a certificate.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import toast from 'react-hot-toast'
import {
  ClipboardCheck, Plus, Pencil, Trash2, Copy, Download, RefreshCw, Lock, Unlock, X,
} from 'lucide-react'
import {
  PageHeader, Field, Input, Textarea, Button, IconButton, Modal, Badge, EmptyState, SkeletonTable,
} from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  QUIZ_MAX_OPTIONS, QUIZ_PASS_PERCENT, blankQuestion, createQuiz, deleteQuiz, quizProblems, cleanQuiz,
  quizUrl, regenerateQuizToken, setQuizActive, subscribeQuizResponses, subscribeQuizzes, updateQuiz,
} from '../lib/quizzes'

const EMPTY = () => ({ title: '', description: '', questions: [blankQuestion()] })

/** The quiz's QR code, with its link and a PNG download. */
function QuizQr({ quiz }) {
  const wrap = useRef(null)
  const url = quizUrl(quiz.token)
  const download = () => {
    const canvas = wrap.current?.querySelector('canvas')
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `quiz-${(quiz.title || 'qr').replace(/[^\w-]+/g, '-').slice(0, 40)}.png`
    a.click()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Quiz link copied')
    } catch {
      toast.error('Could not copy the link')
    }
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <div ref={wrap} className="rounded-xl bg-white p-2 ring-1 ring-ink-200">
        <QRCodeCanvas value={url} size={132} level="M" includeMargin />
      </div>
      <div className="flex gap-1.5">
        <IconButton icon={Copy} label="Copy quiz link" size="sm" onClick={copy} />
        <IconButton icon={Download} label="Download QR code" size="sm" onClick={download} />
      </div>
    </div>
  )
}

export default function Quizzes() {
  const { actor, isManager } = useAuth()
  const [quizzes, setQuizzes] = useState(null)
  const [responses, setResponses] = useState([])
  const [editing, setEditing] = useState(null) // 'new' | quiz | null
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)

  useEffect(() => subscribeQuizzes(setQuizzes), [])
  useEffect(() => subscribeQuizResponses(setResponses), [])

  const counts = useMemo(() => {
    const m = new Map()
    for (const r of responses) {
      const c = m.get(r.quizId) || { total: 0, passed: 0 }
      c.total += 1
      if (r.passed) c.passed += 1
      m.set(r.quizId, c)
    }
    return m
  }, [responses])

  const problems = useMemo(() => quizProblems(cleanQuiz(form)), [form])

  if (!isManager) {
    return <EmptyState icon={ClipboardCheck} title="Quizzes are managed by managers" description="Scan a quiz's QR code to take it." />
  }

  const openNew = () => { setForm(EMPTY()); setEditing('new') }
  const openEdit = (q) => {
    setForm({ title: q.title || '', description: q.description || '', questions: (q.questions || []).map((x) => ({ ...x, options: [...(x.options || [])] })) })
    setEditing(q)
  }

  const setQuestion = (i, patch) =>
    setForm((f) => ({ ...f, questions: f.questions.map((q, n) => (n === i ? { ...q, ...patch } : q)) }))
  const setOption = (i, o, value) =>
    setQuestion(i, { options: form.questions[i].options.map((x, n) => (n === o ? value : x)) })
  const addOption = (i) => setQuestion(i, { options: [...form.questions[i].options, ''] })
  const removeOption = (i, o) => {
    const q = form.questions[i]
    const answer = q.answer === o ? null : q.answer > o ? q.answer - 1 : q.answer
    setQuestion(i, { options: q.options.filter((_, n) => n !== o), answer })
  }
  const addQuestion = () => setForm((f) => ({ ...f, questions: [...f.questions, blankQuestion()] }))
  const removeQuestion = (i) => setForm((f) => ({ ...f, questions: f.questions.filter((_, n) => n !== i) }))

  const save = async (e) => {
    e.preventDefault()
    if (problems.length) { toast.error(problems[0]); return }
    setBusy(true)
    try {
      if (editing === 'new') await createQuiz(form, actor)
      else await updateQuiz(editing.id, form, actor)
      toast.success(editing === 'new' ? 'Quiz created — its QR code is ready' : 'Quiz saved')
      setEditing(null)
    } catch (err) {
      toastCaught(err, 'Could not save the quiz')
    } finally {
      setBusy(false)
    }
  }

  const run = async (fn, done) => {
    try { await fn(); if (done) toast.success(done) } catch (err) { toastCaught(err) }
  }

  return (
    <div>
      <PageHeader
        icon={ClipboardCheck}
        title="Quiz"
        subtitle={`Multiple-choice quizzes taken from a QR code. ${QUIZ_PASS_PERCENT}% or more earns a certificate.`}
        actions={<Button icon={Plus} onClick={openNew}>New quiz</Button>}
      />

      {quizzes === null ? (
        <SkeletonTable rows={3} />
      ) : quizzes.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No quizzes yet"
          description="Create a quiz, then print or share its QR code."
          action={<Button icon={Plus} onClick={openNew}>New quiz</Button>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {quizzes.map((q) => {
            const c = counts.get(q.id) || { total: 0, passed: 0 }
            return (
              <div key={q.id} className="card flex gap-4 p-5">
                <QuizQr quiz={q} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-bold text-ink-900">{q.title}</h2>
                    <Badge tone={q.active ? 'green' : 'gray'}>{q.active ? 'Accepting responses' : 'Closed'}</Badge>
                  </div>
                  {q.description && <p className="mt-1 line-clamp-2 text-sm text-ink-500">{q.description}</p>}
                  <p className="mt-2 text-sm text-ink-600">
                    {(q.questions || []).length} questions · {c.total} response{c.total === 1 ? '' : 's'} · {c.passed} passed
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="soft" icon={Pencil} onClick={() => openEdit(q)}>Edit</Button>
                    <Button size="sm" variant="soft" icon={q.active ? Lock : Unlock}
                      onClick={() => run(() => setQuizActive(q, !q.active, actor), q.active ? 'Quiz closed' : 'Quiz reopened')}>
                      {q.active ? 'Close' : 'Reopen'}
                    </Button>
                    <Button size="sm" variant="ghost" icon={RefreshCw}
                      onClick={() => run(() => regenerateQuizToken(q, actor), 'New QR code issued; the old one no longer works')}>
                      New QR code
                    </Button>
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(q)}>Delete</Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} size="xl"
        title={editing === 'new' ? 'New quiz' : 'Edit quiz'}
        subtitle="Mark the correct option for every question. Answers stay on the server; people taking the quiz never see them.">
        <form onSubmit={save} className="space-y-4">
          <Field label="Title *">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Fire safety basics" />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Shown at the top of the quiz" />
          </Field>
          {editing && editing !== 'new' && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Changing questions or answers applies to responses from now on; results already recorded keep their score.
            </p>
          )}

          {form.questions.map((q, i) => (
            <fieldset key={q.id} className="rounded-xl p-4 ring-1 ring-ink-200">
              <legend className="px-1 text-xs font-bold uppercase tracking-wide text-ink-500">Question {i + 1}</legend>
              <div className="flex items-start gap-2">
                <Field label="Question" className="flex-1">
                  <Textarea rows={2} value={q.text} onChange={(e) => setQuestion(i, { text: e.target.value })} />
                </Field>
                {form.questions.length > 1 && (
                  <IconButton icon={Trash2} label={`Remove question ${i + 1}`} className="mt-6" onClick={() => removeQuestion(i)} />
                )}
              </div>
              <p className="mb-1 mt-3 text-xs text-ink-500">Options: pick the correct one.</p>
              <div className="space-y-2">
                {q.options.map((o, n) => (
                  <div key={n} className="flex items-center gap-2">
                    <input type="radio" name={`correct-${q.id}`} checked={q.answer === n}
                      aria-label={`Option ${n + 1} is correct`} onChange={() => setQuestion(i, { answer: n })} />
                    <Input aria-label={`Question ${i + 1}, option ${n + 1}`} value={o}
                      onChange={(e) => setOption(i, n, e.target.value)} placeholder={`Option ${n + 1}`} />
                    {q.options.length > 2 && (
                      <IconButton icon={X} label={`Remove option ${n + 1}`} size="sm" onClick={() => removeOption(i, n)} />
                    )}
                  </div>
                ))}
              </div>
              {q.options.length < QUIZ_MAX_OPTIONS && (
                <Button type="button" size="sm" variant="ghost" icon={Plus} className="mt-2" onClick={() => addOption(i)}>Add option</Button>
              )}
            </fieldset>
          ))}

          <Button type="button" variant="soft" icon={Plus} onClick={addQuestion}>Add question</Button>

          {problems.length > 0 && (
            <p role="status" className="text-sm text-amber-800">{problems[0]}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={busy || problems.length > 0}>
              {editing === 'new' ? 'Create quiz' : 'Save quiz'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete this quiz?" size="sm">
        <p className="text-sm text-ink-600">
          “{confirmDelete?.title}” and its QR code stop working. Responses already recorded stay in Quiz Results.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => run(async () => { await deleteQuiz(confirmDelete, actor); setConfirmDelete(null) }, 'Quiz deleted')}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  )
}
