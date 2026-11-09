import { forwardRef } from 'react'
import { incidentInvestigations } from '../lib/incidents'
import { incidentChronology, sortChronology, formatChronologyMoment, chronologySpan } from '../lib/chronology'
import { BodyMapStatic } from './BodyMap'
import {
  INCIDENT_TYPE_BY_KEY, SEVERITY_BY_KEY, HSE_CATEGORY_BY_KEY, INVESTIGATION_METHOD_BY_KEY,
  ACTION_STATUS_BY_KEY, bodyPartLabel,
} from '../lib/constants'
import { safeSrc } from '../../../shared/safeUrl'

const fmt = (v) => v || '—'
const personLine = (p) =>
  p.kind === 'internal'
    ? `${p.name || 'Unnamed'}${p.dept ? ` (${p.dept})` : ''}${p.role ? ` — ${p.role}` : ''} · Internal`
    : `${p.name || 'Unnamed'}${p.company ? `, ${p.company}` : ''}${p.contact ? ` · ${p.contact}` : ''}${p.role ? ` — ${p.role}` : ''} · External`

function Section({ title, children }) {
  return (
    <section className="print-block doc-section">
      <h2 className="doc-section-title">{title}</h2>
      {children}
    </section>
  )
}

function Field({ label, value }) {
  return (
    <div className="mb-1.5">
      <span className="text-[11px] font-bold uppercase tracking-wide text-ink-500">{label}: </span>
      <span className="text-sm text-ink-900">{fmt(value)}</span>
    </div>
  )
}

/**
 * Printable incident report. `full=false` → Initial Incident Report (Step 1 +
 * injuries). `full=true` → adds team, investigation (+ diagram image), CAPA and
 * horizontal deployment. Photos/diagram images are passed in.
 *
 * So are `injuries`: the incident carries only the join key now, so the medical
 * block is rendered from the /injuries documents the caller holds. When the
 * reader is not allowed those (`medicalAvailable` false, i.e. anyone below
 * manager) the block states that detail has been omitted. It does not print
 * half a medical record — a reader cannot tell an empty field from an
 * uninjured person, and this document gets filed.
 */
const IncidentReportDoc = forwardRef(function IncidentReportDoc({ incident, photos = [], org, full = false, diagramUrl, injuries = [], medicalAvailable = false }, ref) {
  if (!incident) return <div ref={ref} />
  const type = INCIDENT_TYPE_BY_KEY[incident.type]
  const sev = SEVERITY_BY_KEY[incident.severity]
  const cat = HSE_CATEGORY_BY_KEY[incident.category]
  const evidence = photos.filter((p) => p.kind === 'photo' && p.type?.startsWith('image/'))
  const investigations = incidentInvestigations(incident)
  // Sorted here rather than trusted from the document: an incident whose
  // chronology was written before the wizard started sorting on save, or edited
  // straight in the database, must still print in the order things happened.
  const chronology = sortChronology(incidentChronology(incident))
  const chronoSpan = chronologySpan(chronology)
  const detailFor = (personId) =>
    (medicalAvailable && injuries.find((j) => j.personId === personId)) || null

  return (
    <div ref={ref} className="doc-sheet mx-auto max-w-[800px] p-8">
      <div className="doc-header">
        <div>
          <p className="doc-kicker">Cult Fit SMS · Incident IRA</p>
          <h1 className="doc-title">{full ? 'Incident investigation report' : 'Initial incident report'}</h1>
          <p className="mt-1 text-sm text-ink-500">{org?.name || 'Organization'}</p>
        </div>
        <div className="doc-meta">
          <div><b>{incident.refNo}</b></div>
          <div className="mt-1">Generated {new Date().toLocaleDateString()}</div>
        </div>
      </div>

      <Section title="Incident Details">
        <div className="grid grid-cols-2 gap-x-8">
          <Field label="Date" value={incident.incidentDate} />
          <Field label="Time" value={incident.incidentTime} />
          <Field label="Type" value={type?.label} />
          <Field label="Severity" value={sev?.label} />
          <Field label="HSE Category" value={cat?.label} />
          <Field label="Location" value={incident.location} />
        </div>
      </Section>

      <Section title="Incident Narrative">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{fmt(incident.narrative)}</p>
      </Section>

      <Section title="Probable Cause">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{fmt(incident.probableCause)}</p>
      </Section>

      <Section title="Affected Personnel">
        {(incident.affectedPersonnel || []).length === 0 ? (
          <p className="text-sm text-ink-400">None recorded.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {incident.affectedPersonnel.map((p) => <li key={p.id}>{personLine(p)}</li>)}
          </ul>
        )}
      </Section>

      {(incident.injuryReports || []).length > 0 && (
        <Section title="Injury Reports">
          {incident.injuryReports.map((r, i) => {
            const d = detailFor(r.personId)
            return (
              <div key={r.personId || i} className="print-block mb-3 rounded-lg p-3 ring-1 ring-ink-200">
                <p className="font-bold">{r.personName || 'Injured person'}</p>
                {d ? (
                  <>
                    <div className="mt-1 grid grid-cols-2 gap-x-8">
                      <Field label="First aid done" value={d.firstAidDone ? `Yes${d.firstAidDetail ? ` — ${d.firstAidDetail}` : ''}` : 'No'} />
                      <Field label="Injury type" value={d.injuryType} />
                      <Field label="Body part(s)" value={(d.bodyParts || []).map(bodyPartLabel).join(', ')} />
                      <Field label="Medication" value={d.medication} />
                      <Field label="Days to return to work" value={d.daysToReturnToWork} />
                    </div>
                    {(d.bodyParts || []).length > 0 && (
                      <div className="mt-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                          Injured body-part map
                        </p>
                        <BodyMapStatic parts={d.bodyParts} />
                      </div>
                    )}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-ink-500">
                    {medicalAvailable
                      ? 'No injury report has been filed for this person yet. Injury detail is captured in the Injury Reports record.'
                      : 'An injury report is on file. Its detail — injury type, body part(s), medication, first aid and days to return to work — is part of this person’s medical record, readable by admins and managers only, and has been omitted from this copy.'}
                  </p>
                )}
              </div>
            )
          })}
        </Section>
      )}

      {evidence.length > 0 && (
        <Section title="Photographic Evidence">
          <div className="flex flex-wrap gap-3">
            {evidence.map((p) => (
              <img key={p.id} src={safeSrc(p.dataUrl)} alt={p.name} className="h-40 w-40 rounded object-cover" />
            ))}
          </div>
        </Section>
      )}

      {full && (
        <>
          {/* Opens the investigation half of the report, because it is what the
              rest of it is reasoned from: a root-cause analysis is only as good
              as the sequence it was built on, and a reader has to be able to
              check that sequence before they are asked to accept a conclusion
              drawn from it. */}
          <Section title="Chronology of the Event">
            {chronology.length === 0 ? (
              <p className="text-sm text-ink-400">No chronology recorded.</p>
            ) : (
              <>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 text-left text-[11px] uppercase tracking-wide text-ink-500">
                      <th className="w-[9.5rem] py-1 pr-2">When</th>
                      <th className="py-1 pr-2">What happened</th>
                      <th className="w-[10rem] py-1">Established from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chronology.map((row) => (
                      <tr key={row.id} className="border-b border-ink-100 align-top">
                        <td className="whitespace-nowrap py-1 pr-2 font-semibold">{formatChronologyMoment(row)}</td>
                        <td className="whitespace-pre-wrap py-1 pr-2">{row.event}</td>
                        <td className="py-1 text-ink-600">{fmt(row.source)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {chronoSpan && (
                  <p className="mt-2 text-[11px] text-ink-500">
                    {chronology.length} recorded event{chronology.length === 1 ? '' : 's'}, spanning {chronoSpan} from
                    the first to the last established moment.
                  </p>
                )}
              </>
            )}
          </Section>

          <Section title="Investigation Team">
            {(incident.team || []).length === 0 ? <p className="text-sm text-ink-400">No team recorded.</p> : (
              <ul className="list-disc pl-5 text-sm">{incident.team.map((p) => <li key={p.id}>{personLine(p)}</li>)}</ul>
            )}
          </Section>

          <Section title="Investigation">
            {investigations.length === 0 ? <p className="text-sm text-ink-400">No investigation recorded.</p> : investigations.map((inv, i) => {
              const img = (photos.find((p) => p.id === inv.pngPhotoId)?.dataUrl) || (i === 0 ? diagramUrl : null)
              return (
                <div key={inv.id || i} className={i > 0 ? 'mt-5 border-t border-ink-200 pt-4' : ''}>
                  <Field label="Method" value={INVESTIGATION_METHOD_BY_KEY[inv.method]?.label || inv.method} />
                  {inv.summary && <p className="mt-1 whitespace-pre-wrap text-sm">{inv.summary}</p>}
                  {img && <img src={safeSrc(img)} alt="Investigation diagram" className="mt-3 max-h-[420px] w-full rounded border border-ink-200 object-contain" />}
                </div>
              )
            })}
          </Section>

          <Section title="Corrective & Preventive Actions (CAPA)">
            {(incident.capa || []).length === 0 ? <p className="text-sm text-ink-400">No actions recorded.</p> : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-[11px] uppercase tracking-wide text-ink-500">
                    <th className="py-1 pr-2">Action</th><th className="py-1 pr-2">Owner</th><th className="py-1 pr-2">Due</th><th className="py-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {incident.capa.map((a) => (
                    <tr key={a.id} className="border-b border-ink-100 align-top">
                      <td className="py-1 pr-2">{a.description}</td>
                      <td className="py-1 pr-2">{a.ownerName}</td>
                      <td className="py-1 pr-2">{a.dueDate}</td>
                      <td className="py-1">{ACTION_STATUS_BY_KEY[a.status]?.label || a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Horizontal Deployment">
            <Field label="Required" value={incident.horizontal?.required == null ? '—' : incident.horizontal.required ? 'Yes' : 'No'} />
            {incident.horizontal?.locations?.length > 0 && <Field label="Locations" value={incident.horizontal.locations.join(', ')} />}
            {incident.horizontal?.details && <p className="mt-1 whitespace-pre-wrap text-sm">{incident.horizontal.details}</p>}
          </Section>
        </>
      )}

      <p className="doc-foot">
        This report was generated by Incident IRA. It is a record-keeping aid and does not replace any statutory reporting obligation (e.g. RIDDOR).
      </p>
    </div>
  )
})

export default IncidentReportDoc
