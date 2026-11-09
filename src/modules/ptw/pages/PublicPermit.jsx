// ─────────────────────────────────────────────────────────────────────────────
// The page a work-permit QR code opens.
//
// Every permit printed by this app carries a QR pointing at /permit/<token>,
// and until now that route did not exist — scanning a permit taped to a
// scaffold produced "Page not found". The whole data layer was already here
// (token, public mirror, subscription); the page and its route were not.
//
// It answers one question, for someone standing in front of the work with no
// account and probably no signal to spare: is this permit valid right now. So
// the verdict is the first thing on the screen, in words, before any detail.
//
// It reads the public mirror, which is a copy carrying no approvals, no
// decisions and no attached documents. Nothing here can write back.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  QrCode, Loader2, ShieldCheck, ShieldAlert, Clock, MapPin, User, HardHat,
  AlertTriangle, Building2,
} from 'lucide-react'
import { subscribePermitByToken, createPublicObservation, OBSERVER_ROLES } from '../lib/firestore'
import { derivePermitStatus, statusMeta, effectiveValidTo, STATUS } from '../lib/permitStatus'

/** Statuses under which work may actually proceed. */
const WORKABLE = new Set([STATUS.APPROVED, STATUS.IN_PROGRESS, STATUS.EXTENDED, STATUS.EXTENDED_IN_PROGRESS])

function countdown(toIso, now) {
  const t = Date.parse(toIso || '')
  if (!Number.isFinite(t)) return null
  const left = t - now
  if (left <= 0) return { expired: true, text: 'Expired' }
  const mins = Math.floor(left / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return { expired: false, text: h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining` }
}

export default function PublicPermit() {
  const { token } = useParams()
  const [permit, setPermit] = useState(undefined) // undefined = loading, null = unknown code
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => subscribePermitByToken(token, setPermit, () => setPermit(null)), [token])

  // The verdict is time-sensitive: a permit that expires while someone is
  // looking at it must stop saying it is valid.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const view = useMemo(() => {
    if (!permit) return null
    const status = derivePermitStatus(permit, now)
    const meta = statusMeta(status)
    const validTo = effectiveValidTo(permit)
    return { status, meta, validTo, remaining: countdown(validTo, now), workable: WORKABLE.has(status) }
  }, [permit, now])

  if (permit === undefined) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas">
        <Loader2 size={28} className="animate-spin text-brand-600" />
      </div>
    )
  }

  if (permit === null) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas p-6">
        <div className="card max-w-sm p-8 text-center">
          <QrCode size={32} className="mx-auto text-ink-300" />
          <h1 className="mt-3 text-lg font-bold text-ink-900">Code not recognised</h1>
          <p className="mt-1 text-sm text-ink-500">
            This QR code does not match any work permit on record. It may belong to another system,
            or the permit may have been removed. Do not treat it as authorisation to work — check
            with the issuing department.
          </p>
        </div>
      </div>
    )
  }

  const { meta, validTo, remaining, workable } = view
  const ok = workable && !remaining?.expired

  return (
    <div className="min-h-screen bg-canvas px-4 py-6">
      <div className="mx-auto max-w-md space-y-4">
        {/* The verdict, before anything else. */}
        <div className={`rounded-3xl p-5 text-center shadow-elev ${ok ? 'bg-emerald-600' : 'bg-red-600'}`}>
          {ok ? <ShieldCheck size={34} className="mx-auto text-white" /> : <ShieldAlert size={34} className="mx-auto text-white" />}
          <p className="mt-2 text-lg font-black tracking-tight text-white">
            {ok ? 'Valid — work may proceed' : 'Not valid for work'}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-white/80">{meta.label}</p>
          {remaining && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/20 px-3 py-1 text-xs font-bold text-white">
              <Clock size={12} /> {remaining.text}
            </p>
          )}
        </div>

        {!ok && (
          <p className="rounded-2xl bg-red-50 px-4 py-3 text-center text-[13px] font-semibold leading-snug text-red-800">
            Stop. This permit does not authorise work right now. Contact the issuing department
            before anything starts.
          </p>
        )}

        <div className="card space-y-3 p-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-ink-400">Permit</p>
            <p className="text-lg font-black tracking-tight text-ink-900">{permit.permitNo || '—'}</p>
            {permit.docId && <p className="font-mono text-[11px] text-ink-400">{permit.docId}</p>}
          </div>

          <Row icon={HardHat} label="Type of work" value={permit.typeOfWork} />
          <Row icon={Building2} label="Site" value={permit.site} />
          <Row icon={MapPin} label="Location" value={permit.jobLocation} />
          <Row icon={User} label="Issued to" value={permit.issuedToName} />
          <Row icon={Clock} label="Valid until" value={validTo ? new Date(validTo).toLocaleString() : ''} />

          {permit.jobDescription && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-ink-400">Work</p>
              <p className="text-sm leading-snug text-ink-700">{permit.jobDescription}</p>
            </div>
          )}
        </div>

        {(permit.hazards?.length > 0 || permit.ppe?.length > 0) && (
          <div className="card space-y-3 p-5">
            <Chips label="Hazards" items={permit.hazards} tone="bg-red-100 text-red-800" icon={AlertTriangle} />
            <Chips label="PPE required" items={permit.ppe} tone="bg-sky-100 text-sky-800" />
            <Chips label="Precautions" items={permit.precautions} tone="bg-amber-100 text-amber-800" />
          </div>
        )}

        {/* Counts, not a roster. How many people are meant to be in there is
            the fact a rescue needs; who they are is not, and this page is
            readable by anyone who photographed the code at the barrier. The
            names live on the permit itself, behind sign-in. */}
        {(permit.participantCount > 0 || permit.fireWatcherCount > 0 || permit.hasConfinedWatcher) && (
          <div className="card p-5">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-400">
              People on this permit
            </p>
            <ul className="space-y-1 text-sm text-ink-700">
              {permit.participantCount > 0 && (
                <li>{permit.participantCount} on the work party</li>
              )}
              {permit.fireWatcherCount > 0 && (
                <li>{permit.fireWatcherCount} fire watcher{permit.fireWatcherCount === 1 ? '' : 's'}</li>
              )}
              {permit.hasConfinedWatcher && <li>Confined-space watcher assigned</li>}
            </ul>
          </div>
        )}

        <ObservationForm permit={permit} token={token} />

        <p className="pb-6 text-center text-[11px] leading-snug text-ink-400">
          {permit.orgName || 'Workplace'} · live permit status.
          <br />
          If the work does not match this permit, stop it and tell the issuing department.
        </p>
      </div>
    </div>
  )
}

/**
 * Report what the work actually looks like.
 *
 * Unsafe is the reason this exists, so it is the prominent choice — but the
 * submission is a report, not an instruction: it lands pending for the issuing
 * team rather than closing the permit, which is what the signed-in equivalent
 * does. The wording says so, because someone who believes they have stopped the
 * work when they have not is worse off than someone who knows to also go and
 * tell a person.
 */
function ObservationForm({ permit, token }) {
  const [type, setType] = useState(null) // 'safe' | 'unsafe'
  const [role, setRole] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  if (sent) {
    return (
      <div className="card p-5 text-center">
        <ShieldCheck size={26} className="mx-auto text-emerald-600" />
        <p className="mt-2 text-sm font-bold text-ink-900">Observation sent</p>
        <p className="mt-1 text-[13px] leading-snug text-ink-500">
          The issuing team will see it against this permit.
          {type === 'unsafe' && ' If the work is dangerous right now, stop it and tell a supervisor — do not wait for a reply.'}
        </p>
      </div>
    )
  }

  const submit = async () => {
    if (!type) return
    if (!role) return
    setBusy(true)
    try {
      await createPublicObservation({
        permitId: permit.permitId,
        permitNo: permit.permitNo,
        token,
        type,
        note,
        reporterRole: role,
      })
      setSent(true)
    } catch {
      // Deliberately terse: a stranger on a phone can do nothing with a
      // Firestore error code, and the fallback advice is the same either way.
      setBusy(false)
      setNote('')
      alert('Could not send that. Please tell a supervisor directly.')
    }
  }

  return (
    <div className="card space-y-3 p-5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-ink-400">Report what you see</p>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setType('safe')}
          className={`rounded-2xl px-3 py-3 text-sm font-bold shadow-elev-sm transition active:scale-95 ${
            type === 'safe' ? 'bg-emerald-600 text-white' : 'bg-surface text-emerald-700'
          }`}
        >
          Looks safe
        </button>
        <button
          type="button"
          onClick={() => setType('unsafe')}
          className={`rounded-2xl px-3 py-3 text-sm font-bold shadow-elev-sm transition active:scale-95 ${
            type === 'unsafe' ? 'bg-red-600 text-white' : 'bg-surface text-red-700'
          }`}
        >
          Unsafe
        </button>
      </div>

      {type && (
        <>
          <div>
            <label htmlFor="public-permit-role" className="text-[10px] font-bold uppercase tracking-widest text-ink-400">You are</label>
            <select id="public-permit-role"
              className="mt-1 w-full rounded-xl bg-surface px-3 py-2.5 text-sm  outline-hidden"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="">Select…</option>
              {OBSERVER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          <textarea
            className="min-h-[72px] w-full rounded-xl bg-surface px-3 py-2.5 text-sm  outline-hidden"
            placeholder={type === 'unsafe' ? 'What is unsafe about it?' : 'Anything worth noting (optional)'}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          {type === 'unsafe' && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
              This reports the work to the issuing team — it does not stop it. If it is dangerous
              now, stop the work and tell a supervisor.
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={busy || !role}
            className="w-full rounded-2xl bg-brand-600 px-4 py-3 text-sm font-bold text-white shadow-elev-brand transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send observation'}
          </button>
        </>
      )}
    </div>
  )
}

function Row({ icon: Icon, label, value }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={15} className="mt-0.5 flex-none text-ink-400" />
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-widest text-ink-400">{label}</p>
        <p className="text-sm font-semibold leading-snug text-ink-800">{value}</p>
      </div>
    </div>
  )
}

function Chips({ label, items, tone, icon: Icon }) {
  if (!items?.length) return null
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-ink-400">
        {Icon && <Icon size={11} />} {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((h, i) => (
          <span key={i} className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${tone}`}>{h}</span>
        ))}
      </div>
    </div>
  )
}
