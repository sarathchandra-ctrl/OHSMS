import { EMERGENCY_TEAMS, getFireSourceLabel, getMedicalIncidentLabel } from '../lib/mockDrillTemplates'
import { safeSrc } from '../../../shared/safeUrl'

// Print-only formatted report for a single mock-drill / emergency record.
// Rendered off-screen in MockDrills.jsx and captured by react-to-print.
export default function MockDrillReport({ record }) {
  if (!record) return null
  const r = record
  const checklist = r.checklist || []
  const teamsAlerted = r.teamsAlerted || {}
  const checklistStatus = r.checklistStatus || {}

  return (
    <div className="doc-sheet p-8" style={{ width: '210mm' }}>
      <div className="doc-header">
        <div>
          <p className="doc-kicker">Cult Fit SMS · Fire Marshal</p>
          <h1 className="doc-title">{r.eventType || 'Mock Drill'} report</h1>
        </div>
        <div className="doc-meta">
          <div><b>ID {r.docId || '—'}</b></div>
          <div className="mt-1">Date {r.date || '—'}</div>
        </div>
      </div>

      <table className="doc-table mb-6">
        <tbody>
          <tr>
            <td className="lbl">Scenario</td>
            <td colSpan={3} className="text-base font-semibold">{r.scenario}</td>
          </tr>
          <tr>
            <td className="lbl">Site / Location</td>
            <td>{r.centerName || '—'}</td>
            <td className="lbl">Time</td>
            <td className="font-mono">{r.time || '—'}</td>
          </tr>
          <tr>
            <td className="lbl">Region</td>
            <td>{r.region || '—'}</td>
            <td className="lbl">Commander(s)</td>
            <td className="font-semibold">{r.commander || '—'}</td>
          </tr>
          {r.fireSource && (
            <tr>
              <td className="lbl">Fire source</td>
              <td colSpan={3}>{getFireSourceLabel(r.fireSource)}</td>
            </tr>
          )}
          {r.medicalIncidentType && (
            <tr>
              <td className="lbl">Medical incident</td>
              <td colSpan={3}>{getMedicalIncidentLabel(r.medicalIncidentType)}</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="doc-section">
        <h2 className="doc-section-title">1. Execution metrics</h2>
        <table className="doc-table">
          <tbody>
            <tr>
              <td className="lbl">Evacuation time</td>
              <td className="font-mono">{r.evacTimeMin ? `${r.evacTimeMin} min` : '—'}</td>
              <td className="lbl">ERT response</td>
              <td className="font-mono">{r.ertResponseMin ? `${r.ertResponseMin} min` : '—'}</td>
            </tr>
            <tr>
              <td className="lbl">Head count</td>
              <td className="font-mono">{r.headCount ?? '—'}</td>
              <td className="lbl">Outcome</td>
              <td className="font-semibold">{r.outcome || '—'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h2 className="doc-section-title">2. Teams activated</h2>
        <table className="w-full text-sm">
          <tbody>
            {[0, 4].map((start) => (
              <tr key={start}>
                {EMERGENCY_TEAMS.slice(start, start + 4).map((t, i) => (
                  <td key={t} className="w-[25%] py-1.5 pr-3">
                    <span className="mr-2 font-semibold">{teamsAlerted[start + i] ? '☑' : '☐'}</span>
                    {t}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h2 className="doc-section-title">
          3. {r.scenario === 'Medical Emergency' ? 'Medical examination & response' : 'Procedural execution'} checklist
        </h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th className="w-[15%] text-center">Status</th>
              <th>Protocol item</th>
            </tr>
          </thead>
          <tbody>
            {checklist.length > 0 ? (
              checklist.map((item, idx) => (
                <tr key={idx}>
                  <td className="text-center font-mono font-semibold">
                    {checklistStatus[idx] ? 'PASS' : 'FAIL'}
                  </td>
                  <td>{item}</td>
                </tr>
              ))
            ) : (
              <tr><td className="italic text-ink-500" colSpan={2}>No checklist data.</td></tr>
            )}
            <tr>
              <td className="lbl text-right" colSpan={2}>
                Overall protocol score: {r.score ?? 0}%
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h2 className="doc-section-title">4. Chronological action log</h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th className="w-[15%]">Time</th>
              <th className="w-[40%]">Action taken</th>
              <th>Observation</th>
            </tr>
          </thead>
          <tbody>
            {(r.actionLog || []).length > 0 ? (
              r.actionLog.map((row, i) => (
                <tr key={i}>
                  <td className="font-mono">{row.time || '—'}</td>
                  <td className="font-semibold">{row.action}</td>
                  <td>{row.observation}</td>
                </tr>
              ))
            ) : (
              <tr><td className="text-center italic text-ink-500" colSpan={3}>No action logs recorded.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h2 className="doc-section-title">5. Debrief &amp; CAPA plan</h2>
        <div className="doc-panel mb-4 text-sm">
          <strong>Debrief notes</strong>
          <div className="mt-1 whitespace-pre-wrap">{r.debrief || 'None recorded.'}</div>
        </div>
        <table className="doc-table">
          <thead>
            <tr>
              <th>Action required (CAPA)</th>
              <th className="w-[22%]">Owner</th>
              <th className="w-[15%] text-center">Due</th>
              <th className="w-[14%] text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {(r.capa || []).length > 0 ? (
              r.capa.map((c, i) => (
                <tr key={i}>
                  <td>{c.action}</td>
                  <td className="font-semibold">{c.owner || '—'}</td>
                  <td className="text-center font-mono">{c.due || '—'}</td>
                  <td className="text-center">{c.status || 'Open'}</td>
                </tr>
              ))
            ) : (
              <tr><td className="text-center italic text-ink-500" colSpan={4}>No CAPA items required.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {Array.isArray(r.photos) && r.photos.length > 0 && (
        <div className="doc-section page-break-inside-avoid">
          <h2 className="doc-section-title">6. Evidence photos</h2>
          <div className="flex flex-wrap gap-3">
            {r.photos.map((src, i) => (
              <img key={i} src={safeSrc(src)} alt={`Evidence ${i + 1}`} className="rounded-md ring-1 ring-ink-200 object-contain" style={{ height: '46mm', maxWidth: '31%' }} />
            ))}
          </div>
        </div>
      )}

      {/* role="presentation": this table arranges two signature rules side by
          side on a printed page. It holds no data and has no header row, so
          announcing it as a table — "table with 1 row and 3 columns, column 2
          empty" — describes the layout rather than the document. */}
      <table className="doc-sigs" role="presentation">
        <tbody>
          <tr>
            <td>Incident Commander signature</td>
            <td className="gutter" aria-hidden="true" />
            <td>EHS Manager signature</td>
          </tr>
        </tbody>
      </table>
      <div className="doc-foot text-center font-mono">
        Generated by Fire Marshal · Logged by {r.loggedBy || '—'}
      </div>
    </div>
  )
}
