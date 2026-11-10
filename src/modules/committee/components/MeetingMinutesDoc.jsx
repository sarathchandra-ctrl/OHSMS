// The minutes sheet the print overlay and the mailed PDF both render.
// One component, so the mailbox does not grow a second layout. The mail
// body does not copy action rows; this sheet is what the recipient sees.
import { actionOwnerDisplay } from '../lib/actionOwner'
import { formatDate } from '../../../shared/lib/format'

export default function MeetingMinutesDoc({ meeting, siteLabel = '—' }) {
  if (!meeting) return null
  const m = meeting
  return (
    <div
      className="doc-sheet min-h-screen p-10"
      style={{
        width: '210mm',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
    >
      <div className="doc-header">
        <div>
          <h1 className="doc-title">Consultation &amp; meeting minutes</h1>
        </div>
        <div className="doc-meta">
          <div>
            <b>Ref {m.docId || m.id}</b>
          </div>
          <div className="mt-1">Printed {formatDate(new Date())}</div>
        </div>
      </div>

      <div className="doc-panel mb-8">
        <h2 className="doc-section-title">1. Meeting details</h2>
        <table className="w-full border-none text-sm">
          <tbody>
            <tr>
              <td className="w-[15%] border-b border-ink-200 py-2 font-semibold text-ink-500">
                Type
              </td>
              <td className="w-[35%] border-b border-ink-200 py-2 text-lg font-semibold">
                {m.type}
              </td>
              <td className="w-[15%] border-b border-ink-200 py-2 pl-4 font-semibold text-ink-500">
                Time
              </td>
              <td className="w-[35%] border-b border-ink-200 py-2 font-mono">{m.time || 'N/A'}</td>
            </tr>
            <tr>
              <td className="w-[15%] border-b border-ink-200 py-2 font-semibold text-ink-500">
                Site/Location
              </td>
              <td className="w-[35%] border-b border-ink-200 py-2">{siteLabel}</td>
              <td className="w-[15%] border-b border-ink-200 py-2 pl-4 font-semibold text-ink-500">
                Date
              </td>
              <td className="w-[35%] border-b border-ink-200 py-2 font-mono font-semibold">
                {m.date}
              </td>
            </tr>
            <tr>
              <td className="border-none py-3 align-top font-semibold text-ink-500">
                Subject/Agenda
              </td>
              <td colSpan="3" className="border-none py-3 text-lg font-semibold leading-tight">
                {m.subject}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <section className="doc-section">
        <h2 className="doc-section-title">2. Inputs / Pre-requisites</h2>
        <div className="doc-quote min-h-[50px] leading-relaxed">
          {m.preRequisites || 'None specified.'}
        </div>
      </section>

      <section className="doc-section page-break-inside-avoid">
        <h2 className="doc-section-title">3. Attendance roster</h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th className="w-12 text-center">#</th>
              <th className="w-1/2">Full name</th>
              <th>Role / Affiliation</th>
            </tr>
          </thead>
          <tbody>
            {(m.attendees || []).map((a, i) => (
              <tr key={i}>
                <td className="text-center font-semibold">{i + 1}</td>
                <td className="font-semibold">
                  {a.name} {a.userId === 'External' ? '(Contractor/EXT)' : ''}
                </td>
                <td>{a.role}</td>
              </tr>
            ))}
            {(!m.attendees || m.attendees.length === 0) && (
              <tr>
                <td colSpan="3" className="text-center italic text-ink-500">
                  No attendees recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="doc-section page-break">
        <h2 className="doc-section-title">4. Discussion minutes</h2>
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {m.minutes || 'No formal minutes documented.'}
        </div>
      </section>

      <section className="doc-section page-break-inside-avoid">
        <h2 className="doc-section-title">5. Agreed action plan (CAPA)</h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th className="w-12 text-center">#</th>
              <th>Action item</th>
              <th className="w-1/4">Owner</th>
              <th className="w-32 text-center">Due date</th>
            </tr>
          </thead>
          <tbody>
            {(m.actions || []).map((row, idx) => (
              <tr key={idx}>
                <td className="text-center font-semibold">{idx + 1}</td>
                <td>{row.action}</td>
                <td className="font-semibold">{actionOwnerDisplay(row)}</td>
                <td className="text-center font-mono">{row.due}</td>
              </tr>
            ))}
            {(!m.actions || m.actions.length === 0) && (
              <tr>
                <td colSpan="4" className="text-center italic text-ink-500">
                  No follow-up actions assigned during this meeting.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

    </div>
  )
}
