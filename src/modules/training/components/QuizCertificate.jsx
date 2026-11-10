import { useEffect } from 'react'
import { Printer, X, Award } from 'lucide-react'
import { publicPath } from '../../../shared/publicPath'
import { PrintIsolate } from '../../../shared/ui'
import { formatDate } from '../../../shared/lib/format'
import { QUIZ_PASS_PERCENT } from '../../../../stack/lib/quiz.js'

/**
 * Certificate for a training quiz passed at 80% or more (stack/lib/quiz.js):
 * the Cult logo in the header, the person's name, employee ID and centre, the
 * quiz, the score, the certificate number the server issued with the result,
 * and that it is provided by the Safety & Security Team. Print / Save as PDF
 * from the browser; only the certificate prints.
 *
 * Shown on the QR page straight after a pass, and from Quiz Results for any
 * passing response. `result` is a response: { name, employeeId, centerName,
 * quizTitle, percent, score, total, certificateNo, submittedAt }.
 */
export default function QuizCertificate({ result, onClose }) {
  const shown = Boolean(result?.passed || result?.percent >= QUIZ_PASS_PERCENT)
  useEffect(() => {
    if (!shown) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, onClose])
  if (!shown) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
      <PrintIsolate id="quiz-certificate" landscape />
      {/* Decorative scrim; Escape and the Close button are the ways out. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-4xl" role="dialog" aria-modal="true" aria-label="Quiz certificate">
        <div className="mb-3 flex items-center justify-end gap-2">
          <button type="button" className="btn-primary" onClick={() => window.print()}>
            <Printer size={16} /> Print / Save as PDF
          </button>
          <button type="button" className="btn-ghost bg-white/90" onClick={onClose}>
            <X size={16} /> Close
          </button>
        </div>

        <div
          id="quiz-certificate"
          // Landscape A4 proportions from tablet width up (and in print). On a
          // phone the sheet grows with its text, or the bottom half is cut off.
          className="relative overflow-hidden rounded-xl bg-white p-2 shadow-elev-lg ring-1 ring-ink-200 doc-sheet sm:aspect-[297/200]"
        >
          <div className="flex h-full flex-col rounded-lg ring-1 ring-ink-200">
            {/* Header: the Cult logo. */}
            <div className="flex items-center justify-between gap-4 bg-ink-900 px-8 py-4">
              <div className="flex items-center gap-3">
                <img src={publicPath('/brand/logo.svg')} alt="Cult" className="h-12 w-12 rounded-lg bg-white p-1" />
                <div className="text-left leading-tight">
                  <p className="text-lg font-bold tracking-tight text-white">Cult Fit</p>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/80">
                    Workplace Environment, Health &amp; Safety
                  </p>
                </div>
              </div>
              <Award size={34} className="text-amber-300" aria-hidden />
            </div>

            <div className="flex h-full flex-col items-center px-10 py-6 text-center">
              <p className="doc-kicker">Training assessment</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-ink-900">Certificate of achievement</p>

              <p className="mt-5 text-sm text-ink-500">This certifies that</p>
              <p className="mt-1 text-3xl font-bold tracking-tight text-ink-900">{result.name}</p>
              <p className="mt-1 text-sm text-ink-600">
                Employee ID {result.employeeId} · {result.centerName}
              </p>
              <p className="mt-4 text-sm text-ink-500">has passed the quiz</p>
              <p className="mt-1 text-xl font-semibold text-brand-700">{result.quizTitle}</p>
              <p className="mt-2 text-sm text-ink-700">
                <b>Score</b> {result.score} of {result.total} ({result.percent}%)
              </p>

              <div className="mt-auto flex w-full items-end justify-between pt-6">
                <div className="text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">Certificate no.</p>
                  <p className="font-mono text-xs font-semibold text-ink-800">{result.certificateNo || '—'}</p>
                  <p className="mt-1 text-[10px] text-ink-400">Issued {formatDate(result.submittedAt || new Date())}</p>
                </div>
                {/* No signature line: the certificate is issued by the team, not
                    signed by a person (owner's request, 2026-11-10). */}
                <div className="text-right">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">Provided by</p>
                  <p className="text-xs font-semibold text-ink-800">Safety &amp; Security Team, Cult Fit</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
