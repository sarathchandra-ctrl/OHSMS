// ─────────────────────────────────────────────────────────────────────────────
// /quiz/:token — a training quiz opened from its QR code. Public: whoever
// scans it may have no account. They give their employee ID, name and centre,
// answer every question, and the server scores it (stack/quiz.mjs) against an
// answer key this page never receives. 80% or more shows the certificate.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Award, CheckCircle2, ClipboardCheck, RotateCcw, XCircle } from 'lucide-react'
import { publicPath } from '../../../shared/publicPath'
import { publicQuiz, submitQuiz } from '../../../shared/functions'
import QuizCertificate from '../components/QuizCertificate'

const REASONS = {
  'employee-id': 'Enter your employee ID.',
  name: 'Enter your name.',
  center: 'Enter your centre name.',
  email: 'Enter a valid email ID; your certificate is sent there.',
  answers: 'Answer every question.',
  closed: 'This quiz is not accepting responses any more.',
}

export default function PublicQuiz() {
  const { token } = useParams()
  const [quiz, setQuiz] = useState(undefined) // undefined loading, null unavailable
  const [taker, setTaker] = useState({ employeeId: '', name: '', centerName: '', email: '' })
  const [answers, setAnswers] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [showCert, setShowCert] = useState(false)

  useEffect(() => {
    let live = true
    publicQuiz(token).then((q) => live && setQuiz(q || null), () => live && setQuiz(null))
    return () => { live = false }
  }, [token])

  const header = (
    <div className="flex items-center gap-3">
      <img src={publicPath('/brand/logo.svg')} alt="Cult" className="h-10 w-10 rounded-lg ring-1 ring-ink-200" />
      <div className="leading-tight">
        <p className="text-sm font-bold text-ink-900">Cult Fit</p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">Training quiz</p>
      </div>
    </div>
  )

  if (quiz === undefined) {
    return <div className="grid min-h-screen place-items-center bg-canvas p-6 text-sm text-ink-500">Loading the quiz…</div>
  }
  if (quiz === null) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas p-6">
        <div className="card max-w-sm p-8 text-center">
          <ClipboardCheck size={32} className="mx-auto text-ink-300" />
          <h1 className="mt-3 text-lg font-bold text-ink-900">Quiz not available</h1>
          <p className="mt-1 text-sm text-ink-500">
            This QR code does not open a quiz that is accepting responses. It may have been closed or
            replaced. Ask the person running the training for the current code.
          </p>
        </div>
      </div>
    )
  }

  const answered = quiz.questions.every((_, i) => Number.isInteger(answers[i]))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!taker.employeeId.trim()) return setError(REASONS['employee-id'])
    if (!taker.name.trim()) return setError(REASONS.name)
    if (!taker.centerName.trim()) return setError(REASONS.center)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(taker.email.trim())) return setError(REASONS.email)
    if (!answered) return setError(REASONS.answers)
    setBusy(true)
    try {
      const r = await submitQuiz({ token, ...taker, answers: quiz.questions.map((_, i) => answers[i]) })
      setResult(r)
      setShowCert(Boolean(r?.passed))
      window.scrollTo?.(0, 0)
    } catch (err) {
      setError(REASONS[err?.reason] || err?.message || 'Could not submit. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const tryAgain = () => { setResult(null); setAnswers({}); setShowCert(false) }

  if (result) {
    return (
      <div className="min-h-screen bg-canvas px-4 py-6">
        <div className="mx-auto max-w-md space-y-4">
          {header}
          <div className={`rounded-3xl p-5 text-center shadow-elev ${result.passed ? 'bg-emerald-600' : 'bg-red-600'}`}>
            {result.passed ? <CheckCircle2 size={34} className="mx-auto text-white" /> : <XCircle size={34} className="mx-auto text-white" />}
            <p className="mt-2 text-lg font-black tracking-tight text-white">
              {result.passed ? 'Passed' : 'Not passed this time'}
            </p>
            <p className="mt-1 text-sm font-semibold text-white">
              {result.score} of {result.total} correct · {result.percent}%
            </p>
          </div>
          <div className="card space-y-2 p-5 text-sm text-ink-700">
            <p><b>{result.name}</b> · Employee ID {result.employeeId}</p>
            <p>{result.centerName}</p>
            <p className="text-ink-500">{result.quizTitle}</p>
            {result.passed ? (
              <>
                <p className="text-ink-600">
                  {result.certificateEmail === 'sending'
                    ? `Your certificate is being emailed to ${result.email}. You can also save it now.`
                    : 'Save your certificate now: it could not be emailed from here.'}
                </p>
                <button type="button" className="btn-primary mt-2 w-full" onClick={() => setShowCert(true)}>
                  <Award size={16} /> View certificate
                </button>
              </>
            ) : (
              <>
                <p className="text-ink-600">You need {quiz.passPercent}% to pass and earn the certificate.</p>
                <button type="button" className="btn-soft mt-2 w-full" onClick={tryAgain}>
                  <RotateCcw size={16} /> Try again
                </button>
              </>
            )}
          </div>
        </div>
        {showCert && <QuizCertificate result={result} onClose={() => setShowCert(false)} />}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas px-4 py-6">
      <form className="mx-auto max-w-xl space-y-4" onSubmit={submit} noValidate>
        {header}
        <div className="card p-5">
          <h1 className="text-xl font-black tracking-tight text-ink-900">{quiz.title}</h1>
          {quiz.description && <p className="mt-1 text-sm text-ink-600">{quiz.description}</p>}
          <p className="mt-2 text-xs text-ink-500">
            {quiz.questions.length} questions · {quiz.passPercent}% or more earns a certificate.
          </p>
        </div>

        <div className="card space-y-3 p-5">
          {[
            ['employeeId', 'Employee ID', 'off'],
            ['name', 'Name', 'name'],
            ['centerName', 'Center name', 'off'],
            ['email', 'Email ID', 'email', 'email'],
          ].map(([key, label, auto, type = 'text']) => (
            <div key={key}>
              <label htmlFor={`quiz-${key}`} className="label">{label} *</label>
              <input id={`quiz-${key}`} className="input" type={type} autoComplete={auto} required
                maxLength={key === 'email' ? 254 : 120} inputMode={type === 'email' ? 'email' : undefined}
                value={taker[key]} onChange={(e) => setTaker({ ...taker, [key]: e.target.value })} />
            </div>
          ))}
          <p className="text-xs text-ink-500">If you pass, your certificate is emailed to this address.</p>
        </div>

        {quiz.questions.map((q, i) => (
          <fieldset key={q.id} className="card p-5">
            <legend className="sr-only">Question {i + 1}</legend>
            <p className="text-sm font-semibold text-ink-900">
              <span className="text-ink-400">{i + 1}.</span> {q.text}
            </p>
            <div className="mt-3 space-y-2">
              {q.options.map((o, n) => (
                <label key={n} className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm ring-1 ${answers[i] === n ? 'bg-brand-50 ring-brand-300' : 'ring-ink-200'}`}>
                  <input type="radio" name={`q-${q.id}`} checked={answers[i] === n}
                    onChange={() => setAnswers((a) => ({ ...a, [i]: n }))} />
                  {o}
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit answers'}
        </button>
      </form>
    </div>
  )
}
