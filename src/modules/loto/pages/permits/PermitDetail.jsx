import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { subscribeOrgUsers } from '../../../../shared/org/orgData'
import { useAuth } from '../../context/AuthContext'
import { PERMISSIONS } from '../../constants/roles'
import { usePermit, usePermitEvents, useNow } from '../../hooks/usePermits'
import { workTypeLabel } from '../../constants/permits'
import { deviceLabel, energySourceByKey } from '../../constants/energySources'
import { permitClock, toMs } from '../../utils/permitWindow'
import { otherApproverExists, reachesPermitSite } from '../../utils/permitAccess'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'
import { PermitClockBadge, PermitStatusBadge } from '../../components/permits/PermitBadges'
import PermitStandard from '../../components/permits/PermitStandard'
import PermitActions from '../../components/permits/PermitActions'
import PermitTimeline from '../../components/permits/PermitTimeline'

const fmt = (value) => {
  const ms = toMs(value)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}

function Row({ label, children }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[180px_1fr]">
      <dt className="text-xs font-semibold uppercase tracking-wide text-steel-400">{label}</dt>
      <dd className="text-sm text-steel-100">{children || '—'}</dd>
    </div>
  )
}

export default function PermitDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile, org, can, platformRole } = useAuth()
  const { permit, loading } = usePermit(id)
  const events = usePermitEvents(id)
  const now = useNow()
  const [users, setUsers] = useState([])
  useEffect(() => {
    return subscribeOrgUsers(setUsers)
  }, [])

  if (loading) {
    return (
      <div className="py-24">
        <Spinner label="Loading permit…" />
      </div>
    )
  }
  if (!permit) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card animate={false} className="!p-6 text-sm text-steel-200">
          That permit does not exist, or it was removed after the one-year retention period.
          <div className="mt-4">
            <Button variant="steel" onClick={() => navigate('/loto/permits')}>Back to permits</Button>
          </div>
        </Card>
      </div>
    )
  }

  const isAdmin = can(PERMISSIONS.PERMIT_APPROVE)
  const scopedAdmin = reachesPermitSite(
    { role: platformRole, status: profile.status, siteId: profile.siteId, access: profile.access },
    permit,
  )
  const namedCrew = (permit.personnelUids || []).includes(profile.id) && permit.requestedBy !== profile.id
  const isParty =
    isAdmin || permit.requestedBy === profile.id || (permit.personnelUids || []).includes(profile.id)
  // Self-approval is offered only when nobody else who reaches this permit could approve.
  const otherAdmin = otherApproverExists(
    users.map((u) => ({ ...u, status: u.status || 'approved' })),
    permit,
  )
  const onPdf = () =>
    toast.promise(
      import('../../utils/permitPdf').then((m) =>
        m.generatePermitPdf(permit, { events, orgName: org?.name || '' }),
      ),
      { loading: 'Building permit PDF…', success: 'PDF downloaded', error: 'Could not generate PDF' },
    )
  const lockFor = (key) => (permit.locks || []).find((l) => l.pointKey === key)

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><path d="M9 4h6l1 2h3v14H5V6h3l1-2Z" /><path d="M9 12h6M9 16h4" /></>} />}
        title={`Permit ${permit.permitNo || permit.id}`}
        subtitle={`${workTypeLabel(permit.workType)}${permit.equipment ? ` · ${permit.equipment}` : ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="steel" onClick={onPdf}>
              Download PDF
            </Button>
            <Button variant="steel" onClick={() => navigate('/loto/permits')}>
              All permits
            </Button>
          </div>
        }
      />
      <div className="-mt-3 mb-4 flex flex-wrap items-center gap-2">
        <PermitStatusBadge status={permit.status} />
        <PermitClockBadge clock={permitClock(permit, now)} />
      </div>
      <PermitStandard className="mb-4" />

      <Card animate={false} className="!p-5">
        <dl className="divide-y divide-steel-700/60">
          <Row label="Job">{permit.reason}</Row>
          <Row label="Work order">{permit.workOrder}</Row>
          <Row label="Site">{[permit.site, permit.region, permit.entity].filter(Boolean).join(' · ')}</Row>
          <Row label="Window">
            {fmt(permit.windowStart)} → {fmt(permit.windowEnd)}
            {permit.shift && permit.shift !== 'custom' ? ` (shift ${permit.shift})` : ''}
          </Row>
          <Row label="Requested by">{permit.requestedByName}</Row>
          <Row label="Requested at">{fmt(permit.requestedAt)}</Row>
          <Row label="Colleagues">
            {(permit.internalPersonnel || []).map((p) => p.name).filter(Boolean).join(', ')}
          </Row>
          <Row label="Contractors">
            {(permit.vendorWorkers || []).length > 0 && (
              <ul className="space-y-0.5">
                {permit.vendorWorkers.map((v, i) => (
                  <li key={i}>
                    {v.name} — {v.company}
                    {v.contact ? ` (${v.contact})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <Row label="Procedure">
            {permit.procedureId && (
              <Link className="text-amber-600 hover:underline" to={`/loto/procedures/${permit.procedureId}`}>
                {permit.procedureCode} · rev {permit.procedureRevision}
              </Link>
            )}
          </Row>
          <Row label="Lock-out devices">
            {(permit.devices || []).length > 0 && permit.devices.map(deviceLabel).join(', ')}
          </Row>
        </dl>
      </Card>

      {(permit.isolationPoints || []).length > 0 && (
        <Card animate={false} className="mt-4 overflow-hidden !p-0">
          <h2 className="px-5 pt-4 font-semibold text-steel-100">
            Isolation points ({permit.pointCount})
          </h2>
          <ul className="divide-y divide-steel-700/60">
            {permit.isolationPoints.map((pt) => {
              const lock = lockFor(pt.key)
              return (
                <li key={pt.key} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>
                    <span className="font-mono font-bold text-steel-100">{pt.pointId}</span>{' '}
                    <span className="text-steel-300">
                      {energySourceByKey(pt.energySource)?.label || pt.energyLabel || pt.energySource}
                    </span>
                  </span>
                  <span className="rounded-md bg-hazard px-2 py-0.5 text-xs font-bold text-ink">
                    Lock #{lock?.lockNo || '—'}
                  </span>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      <PermitActions
       
        permit={permit}
        user={profile}
        isAdmin={scopedAdmin}
        canDecide={scopedAdmin && !namedCrew}
        isParty={isParty}
        otherAdmin={otherAdmin}
        canWrite={platformRole !== 'auditor'}
      />
      <PermitTimeline permit={permit} events={events} />
    </div>
  )
}
