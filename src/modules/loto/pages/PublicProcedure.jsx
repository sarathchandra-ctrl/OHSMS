import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { doc, getDoc } from '../../../shared/data/client.js'
import { AlertTriangle, CheckCircle2, Lock, LockOpen, LogIn, ShieldAlert } from 'lucide-react'
import { db } from '../../../shared/db'
import { PUBLIC_COL } from '../utils/publicProcedure'
import { numberIsolationPoints } from '../utils/codes'
import { deviceLabel } from '../constants/energySources'

/**
 * What a scanned procedure QR shows to someone with no account.
 *
 * Reference only, and it says so at the top. A person reading this is standing
 * at a machine, and the one thing this page must never be mistaken for is
 * authorisation to work on it — so there are no controls at all, and locking a
 * point sends you to sign in. The lock states shown are live, which is the
 * point: a code printed months ago still tells the truth about the machine
 * today.
 *
 * Reads the public mirror (see utils/publicProcedure), never the procedure
 * document, so nobody's name is on this page.
 */
export default function PublicProcedure() {
  const { id } = useParams()
  const [state, setState] = useState({ status: 'loading', data: null })

  useEffect(() => {
    let live = true
    if (!id) return undefined
    getDoc(doc(db, PUBLIC_COL, id))
      .then((snap) => {
        if (!live) return
        setState(snap.exists()
          ? { status: 'ready', data: snap.data() }
          : { status: 'missing', data: null })
      })
      .catch(() => live && setState({ status: 'error', data: null }))
    return () => { live = false }
  }, [id])

  if (state.status === 'loading') {
    return <Shell><p className="text-sm text-ink-500">Loading procedure…</p></Shell>
  }

  // Deleted, superseded, or a code from another environment. Deliberately does
  // NOT say "isolated" or "safe" in any form.
  if (state.status !== 'ready') {
    return (
      <Shell>
        <div className="flex items-start gap-3 rounded-2xl bg-amber-50 p-4">
          <ShieldAlert size={20} className="mt-0.5 flex-none text-amber-700" />
          <div>
            <p className="font-bold text-amber-900">This code does not match a current procedure</p>
            <p className="mt-1 text-sm text-amber-800">
              It may have been withdrawn or replaced. Do not treat it as authorisation to work.
              Check with the person responsible for this equipment before going any further.
            </p>
          </div>
        </div>
        <SignIn id={id} label="Sign in" />
      </Shell>
    )
  }

  const p = state.data
  const points = numberIsolationPoints(p.points || [])
  const locked = points.filter((x) => x.locked).length

  return (
    <Shell>
      <div className="rounded-2xl bg-surface p-5 shadow-elev">
        <p className="text-[10px] font-bold uppercase tracking-widest text-ink-500">Isolation procedure</p>
        <h1 className="mt-1 text-xl font-black text-ink-900">{p.equipment || p.title || 'Equipment'}</h1>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink-600">
          {p.site && <span>{p.site}</span>}
          {p.procedureCode && <span className="font-mono text-xs">{p.procedureCode}</span>}
          {Number.isFinite(p.revision) && <span className="text-xs">Rev {p.revision}</span>}
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-xl bg-canvas px-3 py-2 text-sm font-bold">
          {locked > 0
            ? <><Lock size={16} className="text-danger" /><span className="text-danger">{locked} of {points.length} points locked out</span></>
            : <><LockOpen size={16} className="text-ink-500" /><span className="text-ink-700">No points are locked out</span></>}
        </div>

        {p.status && p.status !== 'approved' && (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            This procedure is not approved. Do not use it to isolate equipment.
          </p>
        )}
      </div>

      {/* The reference itself. Read-only, in the order it must be performed. */}
      <ol className="mt-4 space-y-3">
        {points.map((pt) => (
          <li key={pt.key} className="rounded-2xl bg-surface p-4 shadow-elev-sm">
            <div className="flex items-start justify-between gap-3">
              <span
                className="grid h-7 min-w-12 flex-none place-items-center rounded-md px-2 text-xs font-extrabold"
                style={{ background: pt.color, color: pt.textColor }}
              >
                {pt.pointId}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink-900">
                  {pt.energyLabel}
                  {pt.rating ? <span className="ml-1 font-medium text-ink-500">· {pt.rating}</span> : null}
                </p>
                {(pt.device || pt.devices?.length > 0) && (
                  <p className="mt-0.5 text-xs text-ink-500">
                    {[pt.device, ...(pt.devices || [])].filter(Boolean).map(deviceLabel).join(', ')}
                  </p>
                )}
              </div>
              <span
                className={`flex-none rounded-lg px-2 py-1 text-[11px] font-bold ${
                  pt.locked ? 'bg-danger/15 text-danger' : 'bg-canvas text-ink-500'
                }`}
              >
                {pt.locked ? 'Locked' : 'Unlocked'}
              </span>
            </div>

            {pt.isolationDetails && (
              <p className="mt-3 text-sm text-ink-800">{pt.isolationDetails}</p>
            )}
            {pt.hazard && (
              <p className="mt-2 flex gap-2 text-sm text-danger">
                <AlertTriangle size={15} className="mt-0.5 flex-none" />
                <span>{pt.hazard}</span>
              </p>
            )}
            {pt.verification && (
              <p className="mt-2 flex gap-2 text-sm text-ink-700">
                <CheckCircle2 size={15} className="mt-0.5 flex-none text-emerald-600" />
                <span>{pt.verification}</span>
              </p>
            )}
          </li>
        ))}
      </ol>

      <SignIn id={id} label="Sign in to lock out a point" />
    </Shell>
  )
}

/**
 * The only action on the page, and it leaves the page.
 *
 * Carries where to land afterwards, so signing in from a machine takes you to
 * that machine's live operation rather than dropping you on the portal to find
 * it again.
 */
function SignIn({ id, label }) {
  return (
    <Link
      to="/login"
      state={id ? { from: { pathname: `/loto/operations/${id}` } } : undefined}
      className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-4 py-3 text-sm font-bold text-white shadow-elev-sm transition hover:brightness-95"
    >
      <LogIn size={16} /> {label}
    </Link>
  )
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-canvas px-4 py-6">
      <div className="mx-auto max-w-lg">
        {/* First thing on the page, before any instruction, because this is the
            only sentence that stops it being read as a permit to work. */}
        <div className="mb-4 flex items-start gap-2 rounded-2xl bg-magenta-500/15 p-3 text-magenta-700 ring-1 ring-magenta-500/30">
          <ShieldAlert size={16} className="mt-0.5 flex-none" />
          <p className="text-xs font-semibold leading-snug">
            Reference copy. This is not authorisation to work — isolation must be applied and
            verified by an authorised person.
          </p>
        </div>
        {children}
      </div>
    </div>
  )
}
