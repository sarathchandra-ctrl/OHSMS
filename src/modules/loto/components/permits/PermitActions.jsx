import { useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { Field, Textarea } from '../../../../shared/ui'
import Card from '../ui/Card'
import Button from '../ui/Button'
import Input from '../ui/Input'
import PointScanner from './PointScanner'
import LockPhotoCapture from './LockPhotoCapture'
import { EMERGENCY_ATTESTATIONS, MAX_EXTENSION_HOURS, PERMIT_STATUS, RETURN_CHECKS } from '../../constants/permits'
import { resolveTagCode, unscannedPoints } from '../../utils/tagScan'
import { toMs } from '../../utils/permitWindow'
import {
  decidePermit,
  emergencyRemovePermit,
  extendPermit,
  releaseOwnLock,
  requestNewLockPhoto,
  returnPermit,
  startIsolation,
  withdrawPermit,
} from '../../services/permitActions'
import { canRemoveOwnLock, groupDeviceCount } from '../../utils/groupLock'
import { deviceLabel } from '../../constants/energySources'

function Panel({ title, children, tone = '' }) {
  return (
    <Card animate={false} className={`mt-4 space-y-3 !p-5 ${tone}`}>
      <h2 className="font-semibold text-steel-100">{title}</h2>
      {children}
    </Card>
  )
}

/** Runs an action with one busy flag and one toast, so each panel stays declarative. */
function useRun() {
  const [busy, setBusy] = useState(false)
  async function run(fn, success, failure) {
    setBusy(true)
    try {
      await fn()
      if (success) toast.success(success)
      return true
    } catch (err) {
      toastCaught(err, failure)
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

function GroupPanel({ permit, user }) {
  const { busy, run } = useRun()
  const group = permit.groupLock
  if (!group?.active) return null
  const removed = permit.removedUids || []
  const mine = canRemoveOwnLock(group, removed, user.id)
  const tally = groupDeviceCount(group)
  return (
    <Panel title="Group lockout">
      <p className="text-sm text-steel-300">
        {group.method === 'box' ? 'Group lock box' : 'Hasp'} {group.groupNo}. Each person removes only their own lock. The primary comes off last, and that closes the permit.
      </p>
      <p className="text-xs text-steel-400">
        Devices: {Object.entries(tally).map(([k, n]) => `${n} ${deviceLabel(k)}`).join(', ') || '—'}
      </p>
      <ul className="space-y-1 text-sm">
        {group.members.map((m) => (
          <li key={m.uid} className="flex justify-between gap-2">
            <span>{m.name || m.uid} · #{m.lockNo}{m.uid === group.primaryUid ? ' · primary' : ''}</span>
            <span className={removed.includes(m.uid) ? 'text-safe' : 'text-steel-400'}>
              {removed.includes(m.uid) ? 'Off' : 'On'}
            </span>
          </li>
        ))}
      </ul>
      {mine.ok && !mine.closes && (
        <Button
          loading={busy}
          onClick={() => run(() => releaseOwnLock({ permit, user }), 'Your lock is off', 'Could not remove your lock')}
        >
          Remove my lock
        </Button>
      )}
      {mine.ok && mine.closes && (
        <p className="text-sm text-steel-300">You are the last lock. Use Return to close the permit.</p>
      )}
    </Panel>
  )
}

function Decision({ permit, user, otherAdmin }) {
  const { busy, run } = useRun()
  const [note, setNote] = useState('')
  const [selfReason, setSelfReason] = useState('')
  const own = permit.requestedBy === user.id
  // Approving your own request is offered only when nobody else could.
  const blocked = own && otherAdmin
  return (
    <Panel title="Decision">
      {blocked ? (
        <p className="text-sm text-steel-300">
          You raised this permit. Another administrator has to approve it.
        </p>
      ) : (
        <>
          {own && (
            <Field
              label="You are the only administrator — why is there nobody else to approve this?"
              htmlFor="pm-self"
            >
              <Textarea id="pm-self" rows={2} value={selfReason} onChange={(e) => setSelfReason(e.target.value)} />
            </Field>
          )}
          <Field label="Note (required to reject)" htmlFor="pm-note">
            <Textarea id="pm-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy}
              onClick={() =>
                run(
                  () => decidePermit({ permit, user, approve: true, note, selfApprovalReason: selfReason }),
                  'Permit approved',
                  'Could not approve',
                )
              }
            >
              Approve
            </Button>
            <Button
              variant="steel"
              loading={busy}
              onClick={() =>
                run(
                  () => decidePermit({ permit, user, approve: false, note }),
                  'Permit rejected',
                  'Could not reject',
                )
              }
            >
              Reject
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

function Withdraw({ permit, user }) {
  const { busy, run } = useRun()
  return (
    <div className="mt-4">
      <Button
        variant="steel"
        loading={busy}
        onClick={() => {
          if (!window.confirm('Withdraw this permit? It cannot be reopened.')) return
          run(() => withdrawPermit({ permit, user }), 'Permit withdrawn', 'Could not withdraw')
        }}
      >
        Withdraw permit
      </Button>
    </div>
  )
}

function RequestPhoto({ permit, user }) {
  const { busy, run } = useRun()
  const [note, setNote] = useState('')
  return (
    <Panel title="Ask for a new lock photo">
      <Field label="What is wrong with the photo?" htmlFor="pm-photo-redo">
        <Textarea id="pm-photo-redo" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button
        variant="steel"
        loading={busy}
        onClick={() => run(() => requestNewLockPhoto({ permit, user, note }), 'A new photo was requested', 'Could not request a photo')}
      >
        Request a new photo
      </Button>
    </Panel>
  )
}

function Isolation({ permit, user }) {
  const { busy, run } = useRun()
  const [scans, setScans] = useState({})
  const [tryout, setTryout] = useState('')
  const [shot, setShot] = useState(null)
  const points = permit.isolationPoints || []
  const left = unscannedPoints(points, scans)
  const lockOf = (key) => (permit.locks || []).find((l) => l.pointKey === key)?.lockNo
  const photoReady = Boolean(shot?.path)

  function onCode(raw, method) {
    const r = resolveTagCode(raw, { procedureId: permit.procedureId, points })
    if (!r.ok) return toast.error(r.reason)
    setScans((s) => {
      if (s[r.point.key]) return s
      toast.success(`Tag ${r.point.pointId} scanned`)
      return { ...s, [r.point.key]: { at: Date.now(), method } }
    })
  }

  // A permit written before every permit had isolation points has nothing to scan.
  return (
    <Panel title="Isolate and start">
      {points.length > 0 && (
        <>
          <p className="text-sm text-steel-300">
            Apply the lock at each point, then scan the tag QR at that point. Work can start only when
            every point is scanned; starting locks all of them in one step.
          </p>
          <ul className="divide-y divide-steel-700/60 rounded-xl border border-steel-700">
            {points.map((pt) => (
              <li key={pt.key} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  <span className="font-mono font-bold text-steel-100">{pt.pointId}</span>{' '}
                  <span className="text-steel-400">lock #{lockOf(pt.key) || '—'}</span>
                </span>
                <span className={scans[pt.key] ? 'font-semibold text-safe' : 'text-steel-400'}>
                  {scans[pt.key] ? `Scanned (${scans[pt.key].method})` : 'Not scanned'}
                </span>
              </li>
            ))}
          </ul>
          <PointScanner onCode={onCode} disabled={busy} />
        </>
      )}
      <fieldset className="space-y-1">
        <legend className="text-sm font-semibold text-steel-100">Zero-energy try-out</legend>
        <label className="flex items-center gap-2 text-sm text-steel-200">
          <input type="radio" name="tryout" value="yes" checked={tryout === 'yes'} onChange={() => setTryout('yes')} />
          Yes, zero energy
        </label>
        <label className="flex items-center gap-2 text-sm text-steel-200">
          <input type="radio" name="tryout" value="no" checked={tryout === 'no'} onChange={() => setTryout('no')} />
          No
        </label>
        {tryout === 'no' && <p role="alert" className="text-xs font-medium text-red-400">A No blocks Start.</p>}
      </fieldset>
      <LockPhotoCapture
        userName={user.displayName}
        permitNo={permit.permitNo || permit.id}
        equipment={permit.equipment}
        onPhoto={async (shot) => {
          try {
            const { storeLockPhoto } = await import('../../services/lockPhoto')
            const stored = await storeLockPhoto({ permit, dataUrl: shot.dataUrl })
            setShot(stored)
          } catch (err) {
            toast.error(err?.message || 'Could not store the lock photo.')
          }
        }}
      />
      <Button
        loading={busy}
        disabled={left.length > 0 || tryout !== 'yes' || !photoReady}
        onClick={() =>
          run(
            () => startIsolation({
              permit, scans, user,
              tryout: { zeroEnergy: true },
              lockPhoto: shot,
            }),
            'Locked out — permit is active',
            'Could not start',
          )
        }
      >
        {points.length ? `Lock all ${points.length} and start work` : 'Start work'}
      </Button>
      {left.length > 0 && (
        <p className="text-xs text-steel-400">
          {left.length} tag{left.length === 1 ? '' : 's'} still to scan: {left.map((p) => p.pointId).join(', ')}
        </p>
      )}
    </Panel>
  )
}

function Return({ permit, user }) {
  const { busy, run } = useRun()
  const [ticked, setTicked] = useState({})
  const [confirmed, setConfirmed] = useState([])
  const points = permit.isolationPoints || []
  const lockOf = (key) => (permit.locks || []).find((l) => l.pointKey === key)?.lockNo
  const toggle = (key) => setTicked((t) => ({ ...t, [key]: !t[key] }))
  const toggleLock = (key) =>
    setConfirmed((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]))
  const ready = RETURN_CHECKS.every((c) => ticked[c.key]) && points.every((p) => confirmed.includes(p.key))
  return (
    <Panel title="Return the equipment">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-steel-200">Before re-energising</legend>
        {RETURN_CHECKS.map((c) => (
          <label key={c.key} className="flex items-start gap-2 text-sm text-steel-200">
            <input type="checkbox" className="mt-1" checked={Boolean(ticked[c.key])} onChange={() => toggle(c.key)} />
            {c.label}
          </label>
        ))}
      </fieldset>
      {points.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-steel-200">Confirm each lock is off</legend>
          {points.map((pt) => (
            <label key={pt.key} className="flex items-start gap-2 text-sm text-steel-200">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmed.includes(pt.key)}
                onChange={() => toggleLock(pt.key)}
              />
              I have removed lock #{lockOf(pt.key) || '—'} from point {pt.pointId}
            </label>
          ))}
        </fieldset>
      )}
      <Button
        loading={busy}
        disabled={!ready}
        onClick={() =>
          run(
            () => returnPermit({ permit, user, ticked, confirmed }),
            'Equipment returned — permit closed',
            'Could not return',
          )
        }
      >
        Unlock all and return
      </Button>
    </Panel>
  )
}

function Extend({ permit, user }) {
  const { busy, run } = useRun()
  const [hours, setHours] = useState('1')
  const [reason, setReason] = useState('')
  const add = Number(hours)
  return (
    <Panel title="Extend the window (Admin)">
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
        <Input
          label="Add hours"
          type="number"
          min="0.25"
          max={MAX_EXTENSION_HOURS}
          step="0.25"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
        <Field label="Reason" htmlFor="pm-ext-reason">
          <Textarea id="pm-ext-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <Button
        variant="steel"
        loading={busy}
        disabled={!(add > 0)}
        onClick={() =>
          run(
            () =>
              extendPermit({
                permit,
                user,
                newEndMs: toMs(permit.windowEnd) + Math.round(add * 3600 * 1000),
                reason,
              }),
            'Window extended',
            'Could not extend',
          )
        }
      >
        Extend
      </Button>
    </Panel>
  )
}

function Emergency({ permit, user }) {
  const { busy, run } = useRun()
  const [reason, setReason] = useState('')
  const [attest, setAttest] = useState({})
  const ready = EMERGENCY_ATTESTATIONS.every((a) => attest[a.key])
  return (
    <Panel title="Emergency removal (Admin)" tone="border-danger/40">
      <p className="text-sm text-steel-300">
        Removes every lock without the person who applied it. The reason and your attestations are kept
        with the permit and sent to everyone named on it.
      </p>
      <Field label="Reason" htmlFor="pm-em-reason">
        <Textarea id="pm-em-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-steel-200">I attest that</legend>
        {EMERGENCY_ATTESTATIONS.map((a) => (
          <label key={a.key} className="flex items-start gap-2 text-sm text-steel-200">
            <input
              type="checkbox"
              className="mt-1"
              checked={Boolean(attest[a.key])}
              onChange={() => setAttest((s) => ({ ...s, [a.key]: !s[a.key] }))}
            />
            {a.label}
          </label>
        ))}
      </fieldset>
      <Button
        loading={busy}
        disabled={!ready}
        onClick={() => {
          if (!window.confirm('Remove all locks under this permit now?')) return
          run(
            () => emergencyRemovePermit({ permit, user, reason, attest }),
            'Locks removed — permit closed',
            'Could not remove',
          )
        }}
      >
        Remove all locks
      </Button>
    </Panel>
  )
}

/**
 * The buttons a permit offers THIS person right now. What they can actually do
 * is decided by firestore.rules; this only decides what to show.
 */
export default function PermitActions({ permit, user, isAdmin, isParty, otherAdmin, canWrite, canDecide = isAdmin }) {
  if (!canWrite) return null
  const requester = permit.requestedBy === user.id
  switch (permit.status) {
    case PERMIT_STATUS.REQUESTED:
      return (
        <>
          {canDecide && <Decision permit={permit} user={user} otherAdmin={otherAdmin} />}
          {(requester || isAdmin) && <Withdraw permit={permit} user={user} />}
        </>
      )
    case PERMIT_STATUS.APPROVED:
      return (
        <>
          {isParty && <Isolation permit={permit} user={user} />}
          {isAdmin && <RequestPhoto permit={permit} user={user} />}
          {(requester || isAdmin) && <Withdraw permit={permit} user={user} />}
        </>
      )
    case PERMIT_STATUS.ACTIVE:
      return (
        <>
          {isParty && <Return permit={permit} user={user} />}
          {permit.groupLock && <GroupPanel permit={permit} user={user} />}
          {isAdmin && <Extend permit={permit} user={user} />}
          {isAdmin && <Emergency permit={permit} user={user} />}
        </>
      )
    default:
      return null
  }
}
