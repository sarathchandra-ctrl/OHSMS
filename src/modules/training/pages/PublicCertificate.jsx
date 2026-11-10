// ─────────────────────────────────────────────────────────────────────────────
// /certificate/:token — a passing quiz certificate, opened from the link in
// the email sent to the person it certifies (stack/quiz.mjs). Public, and
// shows the certificate and nothing else. A manager who sends it again issues
// a new link, and this one then stops working.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Award } from 'lucide-react'
import { quizCertificate } from '../../../shared/functions'
import QuizCertificate from '../components/QuizCertificate'

export default function PublicCertificate() {
  const { token } = useParams()
  const [cert, setCert] = useState(undefined) // undefined loading, null unavailable

  useEffect(() => {
    let live = true
    quizCertificate(token).then((c) => live && setCert(c || null), () => live && setCert(null))
    return () => { live = false }
  }, [token])

  if (cert === undefined) {
    return <div className="grid min-h-screen place-items-center bg-canvas p-6 text-sm text-ink-500">Loading the certificate…</div>
  }
  if (cert === null) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas p-6">
        <div className="card max-w-sm p-8 text-center">
          <Award size={32} className="mx-auto text-ink-300" />
          <h1 className="mt-3 text-lg font-bold text-ink-900">Certificate not available</h1>
          <p className="mt-1 text-sm text-ink-500">
            This link does not open a certificate. It may have been replaced by a newer one — check
            your most recent email, or ask the Safety &amp; Security Team to send it again.
          </p>
        </div>
      </div>
    )
  }
  return <QuizCertificate result={cert} standalone />
}
