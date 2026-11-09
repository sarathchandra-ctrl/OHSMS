import { forwardRef } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { statusMeta } from '../lib/permitStatus'
import { publicPermitUrl } from '../lib/qr'
import { qrFrameStyle } from '../../../shared/print/qrFrame'

const fmt = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function decisionLine(label, block) {
  if (!block) return `${label}: —`
  const s =
    block.status === 'approved' ? 'Approved' : block.status === 'rejected' ? 'Rejected' : 'Pending'
  return `${label}: ${s}${block.byName ? ` by ${block.byName}` : ''}${block.at ? ` (${fmt(block.at)})` : ''}`
}

/** Repeated diagonal status watermark in the status color. */
function Watermark({ label, color }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        transform: 'rotate(-30deg)',
        opacity: 0.1,
      }}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            whiteSpace: 'nowrap',
            fontSize: '46px',
            fontWeight: 900,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color,
            lineHeight: 1.9,
          }}
        >
          {`${label}\u00a0\u00a0\u00a0${label}\u00a0\u00a0\u00a0${label}`}
        </div>
      ))}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ position: 'relative', zIndex: 1, marginTop: 16 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: '#5b6573',
          borderBottom: '1px solid #e2e8f0',
          paddingBottom: 4,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0' }}>
      <span style={{ width: 150, color: '#5b6573', flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#0f172a', fontWeight: 600 }}>{value || '—'}</span>
    </div>
  )
}

function Tags({ items }) {
  if (!items?.length) return <span style={{ fontSize: 12, color: '#5b6573' }}>None</span>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((t) => (
        <span
          key={t}
          style={{
            fontSize: 11,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            padding: '2px 8px',
            color: '#2c3848',
          }}
        >
          {t}
        </span>
      ))}
    </div>
  )
}

/** Full A4 printable permit document. Used by react-to-print on the detail page. */
const PermitPrintable = forwardRef(function PermitPrintable({ permit, documents = [] }, ref) {
  if (!permit) return <div ref={ref} />
  const meta = statusMeta(permit.status)

  return (
    <div
      ref={ref}
      className="print-area"
      style={{
        position: 'relative',
        background: '#ffffff',
        color: '#0f172a',
        padding: 28,
        fontFamily: "'Open Sans', system-ui, sans-serif",
      }}
    >
      <Watermark label={meta.label} color={meta.color} />

      {/* Header */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          borderBottom: `2px solid ${meta.color}`,
          paddingBottom: 10,
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 auto', marginRight: 16 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#3d7a72',
              marginBottom: 4,
              overflowWrap: 'anywhere',
            }}
          >
            Cult Fit SMS · Permit to work
          </div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: '#0f172a',
              overflowWrap: 'anywhere',
            }}
          >
            Permit to work
          </div>
          <div style={{ fontSize: 12, color: '#5b6573', overflowWrap: 'anywhere' }}>
            {permit.permitNo}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: '0 0 auto' }}>
          <div style={{ textAlign: 'right', maxWidth: 140 }}>
            <span
              style={{
                display: 'inline-block',
                background: meta.color,
                color: '#fff',
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 700,
                overflowWrap: 'anywhere',
              }}
            >
              {meta.label}
            </span>
            <div style={{ fontSize: 11, color: '#5b6573', marginTop: 4, overflowWrap: 'anywhere' }}>
              Printed {fmt(new Date().toISOString())}
            </div>
          </div>
          {permit.qrToken && (
            <div style={qrFrameStyle()}>
              <QRCodeCanvas value={publicPermitUrl(permit.qrToken)} size={72} level="M" />
            </div>
          )}
        </div>
      </div>

      <Section title="Work details">
        <Row label="Type of work" value={permit.typeOfWork} />
        {permit.site ? <Row label="Site" value={permit.site} /> : null}
        <Row label="Date / start time" value={`${permit.date || '—'}  ${permit.time || ''}`} />
        <Row label="Valid from" value={fmt(permit.validFrom)} />
        <Row label="Valid to" value={fmt(permit.validTo)} />
        <Row label="Job location" value={permit.jobLocation} />
        <Row label="Issuing department" value={permit.issuingDepartment} />
        <Row
          label="Issued to"
          value={`${permit.issuedToName || '—'}${permit.issuedToPhone ? ` · ${permit.issuedToPhone}` : ''}`}
        />
        <Row label="Job description" value={permit.jobDescription} />
        <Row label="Raised by" value={permit.createdByName} />
      </Section>

      <Section title="Hazard identification">
        <Tags items={permit.hazards} />
      </Section>

      {permit.jsa?.length > 0 && (
        <Section title="Job Safety Analysis">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                <th
                  style={{
                    padding: '6px 8px',
                    border: '1px solid #e2e8f0',
                    width: '33%',
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: '#5b6573',
                  }}
                >
                  Activity step
                </th>
                <th
                  style={{
                    padding: '6px 8px',
                    border: '1px solid #e2e8f0',
                    width: '33%',
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: '#5b6573',
                  }}
                >
                  Hazard
                </th>
                <th
                  style={{
                    padding: '6px 8px',
                    border: '1px solid #e2e8f0',
                    fontSize: 10,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: '#5b6573',
                  }}
                >
                  Precaution
                </th>
              </tr>
            </thead>
            <tbody>
              {permit.jsa.map((r, i) => (
                <tr key={i}>
                  <td
                    style={{
                      padding: '6px 8px',
                      border: '1px solid #e2e8f0',
                      verticalAlign: 'top',
                    }}
                  >
                    {r.step || '—'}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      border: '1px solid #e2e8f0',
                      verticalAlign: 'top',
                    }}
                  >
                    {r.hazard || '—'}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      border: '1px solid #e2e8f0',
                      verticalAlign: 'top',
                    }}
                  >
                    {r.precaution || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="PPE required">
        <Tags items={permit.ppe} />
      </Section>
      <Section title="Precautions">
        <Tags items={permit.precautions} />
      </Section>

      <Section title="Participants">
        {permit.participants?.length ? (
          <div style={{ display: 'grid', gap: 4 }}>
            {permit.participants.map((p, i) => (
              <div key={i} style={{ fontSize: 12, color: '#0f172a' }}>
                <strong>{p.name}</strong> <span style={{ color: '#5b6573' }}>({p.type})</span>
                {p.company ? ` · ${p.company}` : ''}
                {p.contact ? ` · ${p.contact}` : ''}
              </div>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 12, color: '#5b6573' }}>None</span>
        )}
      </Section>

      {permit.fireWatchers?.length > 0 && (
        <Section title="Fire watcher(s)">
          {permit.fireWatchers.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: '#0f172a' }}>
              <strong>{w.name}</strong>
              {w.details ? ` · ${w.details}` : ''}
            </div>
          ))}
        </Section>
      )}

      {permit.confinedWatcher?.name && (
        <Section title="Standby watcher / attendant">
          <div style={{ fontSize: 12, color: '#0f172a' }}>
            <strong>{permit.confinedWatcher.name}</strong>
            {permit.confinedWatcher.details ? ` · ${permit.confinedWatcher.details}` : ''}
          </div>
        </Section>
      )}

      {(permit.requiredDocs?.length > 0 || documents.length > 0) && (
        <Section title="Documents">
          {permit.requiredDocs?.map((req) => {
            const attached = documents.some((d) => d.key === req.key)
            return (
              <div key={req.key} style={{ fontSize: 12, color: '#0f172a', padding: '1px 0' }}>
                {attached ? '☑' : '☐'} {req.label}
                {req.mandatory ? ' (mandatory)' : ''}
                {attached ? '' : ' — not attached'}
              </div>
            )
          })}
          {documents
            .filter((d) => d.key === 'extra')
            .map((d) => (
              <div key={d.id} style={{ fontSize: 12, color: '#0f172a', padding: '1px 0' }}>
                ☑ {d.fileName} (other)
              </div>
            ))}
        </Section>
      )}

      <Section title="Approvals">
        <Row label="Engineering" value={decisionLine('', permit.engineering).replace(': ', '')} />
        <Row label="Operations" value={decisionLine('', permit.operations).replace(': ', '')} />
        {permit.assignedEngineer && (
          <Row label="Assigned engineer" value="Specific approver assigned" />
        )}
        {permit.assignedOperator && (
          <Row label="Assigned operator" value="Specific approver assigned" />
        )}
      </Section>

      {permit.extension && (
        <Section title="Extension">
          <Row label="Reason" value={permit.extension.reason} />
          <Row label="New valid to" value={fmt(permit.extension.newValidTo)} />
          <Row label="Participant changes" value={permit.extension.participantChanges} />
          <Row label="Risk changes" value={permit.extension.riskChanges} />
          <Row
            label="Engineering"
            value={decisionLine('', permit.extension.engineering).replace(': ', '')}
          />
          <Row
            label="Operations"
            value={decisionLine('', permit.extension.operations).replace(': ', '')}
          />
        </Section>
      )}

      {permit.closure && (
        <Section title="Closure">
          <Row
            label="Requested by"
            value={`${permit.closure.requestedByName || '—'} (${fmt(permit.closure.requestedAt)})`}
          />
          <Row
            label="Engineering"
            value={decisionLine('', permit.closure.engineering).replace(': ', '')}
          />
          <Row
            label="Operations"
            value={decisionLine('', permit.closure.operations).replace(': ', '')}
          />
        </Section>
      )}

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          marginTop: 28,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        {['Issuer', 'Engineering', 'Operations'].map((sig) => (
          <div
            key={sig}
            style={{
              flex: 1,
              borderTop: '1px solid #cbd5e1',
              paddingTop: 6,
              fontSize: 11,
              color: '#5b6573',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            {sig} sign &amp; date
          </div>
        ))}
      </div>
    </div>
  )
})

export default PermitPrintable
