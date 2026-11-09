import { Printer, X, Award } from 'lucide-react'
import { PrintIsolate } from '../../../shared/ui'
import { formatDate } from '../../../shared/lib/format'

/**
 * WEHS training certificate — on-screen preview + print/PDF ("Save as PDF" in
 * the browser print dialog). The injected print style isolates the certificate
 * so only it prints, in landscape. Chrome matches the amber+white glass kit: white
 * paper, hairline, logo teal accent — not a serif diploma.
 */
export default function CertificateModal({ record, orgName, onClose }) {
  if (!record) return null
  const certNo = `CFSMS-TR-${(record.id || '').slice(0, 8).toUpperCase() || 'DRAFT'}`

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <PrintIsolate id="wehs-certificate" landscape />
      {/* Decorative scrim. It is not a tab stop and must not be: the keyboard way
          out of a dialog is Escape, which useFocusTrap handles, and making the
          backdrop focusable would put a nameless control in the tab order in
          front of the dialog it is dimming. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-4xl">
        <div className="mb-3 flex items-center justify-end gap-2">
          <button className="btn-primary" onClick={() => window.print()}>
            <Printer size={16} /> Print / Save as PDF
          </button>
          <button className="btn-ghost bg-white/90" onClick={onClose}>
            <X size={16} /> Close
          </button>
        </div>

        <div
          id="wehs-certificate"
          className="relative overflow-hidden rounded-xl bg-white p-2 shadow-elev-lg ring-1 ring-ink-200 doc-sheet"
          style={{ aspectRatio: '297/200' }}
        >
          <div className="flex h-full flex-col rounded-lg ring-1 ring-ink-200">
            <div className="h-1.5 w-full bg-[#3d7a72]" />
            <div className="flex h-full flex-col items-center px-10 py-7 text-center">
              <div className="flex items-center gap-3">
                <img
                  src="/brand/logo.svg"
                  alt="Cult Fit SMS"
                  className="h-12 w-12 rounded-lg ring-1 ring-ink-200"
                />
                <div className="text-left leading-tight">
                  <p className="text-base font-bold tracking-tight text-ink-900">Cult Fit SMS</p>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                    Workplace Environment, Health &amp; Safety
                  </p>
                </div>
              </div>

              <p className="doc-kicker mt-6">Training record</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-ink-900">
                Certificate of completion
              </p>

              <p className="mt-5 text-sm text-ink-500">This certifies that</p>
              <p className="mt-1 text-3xl font-bold tracking-tight text-ink-900">
                {record.employeeName}
              </p>
              <p className="mt-3 text-sm text-ink-500">has completed</p>
              <p className="mt-1 text-xl font-semibold text-brand-700">{record.courseName}</p>
              <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                {record.category || 'Training'}
                {record.trainerName ? ` · Trainer: ${record.trainerName}` : ''}
              </p>

              <div className="mt-5 flex items-center gap-10 text-sm text-ink-700">
                <span>
                  <b>Completed</b> {formatDate(record.completedOn)}
                </span>
                {record.expiresOn && (
                  <span>
                    <b>Valid until</b> {formatDate(record.expiresOn)}
                  </span>
                )}
              </div>

              <div className="mt-auto flex w-full items-end justify-between pt-6">
                <div className="text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                    Certificate no.
                  </p>
                  <p className="font-mono text-xs font-semibold text-ink-800">{certNo}</p>
                  <p className="mt-1 text-[10px] text-ink-400">
                    Issued by {orgName || 'Cult Fit'} · {formatDate(new Date())}
                  </p>
                </div>
                <Award size={36} className="text-brand-600" aria-hidden />
                <div className="text-right">
                  <div className="mb-1 h-px w-40 bg-ink-200" />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                    HSE Manager — {orgName || 'Organization'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
