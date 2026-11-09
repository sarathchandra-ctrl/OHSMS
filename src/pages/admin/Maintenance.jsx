import { useState } from 'react'
import toast from 'react-hot-toast'
import { ShieldCheck, FileStack, Play, Check, Bug, Unlock, QrCode, HeartPulse, Stethoscope, FileLock2, MapPin, Lock, UserSearch, Download } from 'lucide-react'
import { Card, Button } from '../../shared/ui'
import { reportError } from '../../shared/monitoring'
import { useAuth } from '../../shared/auth/AuthContext'
import { backfillProcedureMirrors } from '../../modules/loto/services/procedures'
import { backfillLockClaims } from '../../modules/loto/services/lockClaims'
import { backfillAll } from '../../shared/crypto/backfill'
import { sealingEnabled } from '../../shared/crypto/keyring'
import { downloadBlob } from '../../shared/lib/download'

/**
 * Maintenance jobs an administrator runs from the browser. Each is idempotent
 * and runs in this browser against the organization's own server.
 */
export default function Maintenance() {
  return (
    <div className="space-y-4">
      <SealHistory />
      <ProcedureMirrors />
      <LockClaims />
      <ErrorReporting />
    </div>
  )
}

/**
 * Publish the isolation procedures that predate the public QR view.
 *
 * The QR printed on a LOTO procedure now opens a read-only view for whoever is
 * standing at the machine, with no account. That view reads a mirror document
 * holding the instructions and the live lock state, and deliberately not the
 * names of the people who applied the locks.
 *
 * Every writer keeps the mirror current, and each rebuilds it in full, so any
 * procedure that gets locked, approved or revised publishes itself. The gap is
 * the procedure nobody touches — an approved isolation on a machine that is
 * simply running. Its code would answer "does not match a current procedure",
 * which on a LOTO tag is an alarming way to say "nothing has changed".
 *
 * Unlike its neighbours this runs in the browser rather than as a callable: the
 * writes are the same ones the app already makes, under the same rules, so it
 * needs no privilege an admin does not already have.
 */
function ProcedureMirrors() {
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [done, setDone] = useState(false)

  const run = async (dryRun) => {
    setBusy(dryRun ? 'dry' : 'write')
    try {
      const r = await backfillProcedureMirrors({ dryRun })
      setPreview(r)
      if (!dryRun) {
        setDone(true)
        toast.success(`Published ${r.written} procedure${r.written === 1 ? '' : 's'}`)
      } else if (r.missing === 0) {
        toast.success('Nothing to do — every procedure is already published')
      }
    } catch (err) {
      reportError(err, { where: 'backfillProcedureMirrors' })
      toast.error(err?.message || 'Failed')
    } finally {
      setBusy('')
    }
  }

  const nothingToDo = preview && preview.missing === 0

  return (
    <Job
      icon={QrCode}
      title="Publish procedure QR pages"
      result={preview && [
        `${preview.total} procedure${preview.total === 1 ? '' : 's'} in this organization`,
        `${preview.present} already published`,
        `${preview.missing} whose printed code leads nowhere`,
        preview.ids?.length ? `\n${preview.ids.map((i) => `  · ${i}`).join('\n')}` : '',
      ].filter(Boolean).join('\n')}
      actions={
        <>
          <Button variant="ghost" icon={Play} loading={busy === 'dry'} disabled={Boolean(busy)} onClick={() => run(true)}>
            Check first
          </Button>
          <Button
            icon={done ? Check : undefined}
            loading={busy === 'write'}
            disabled={Boolean(busy) || !preview || nothingToDo}
            onClick={() => run(false)}
          >
            {done ? 'Published' : 'Publish them'}
          </Button>
        </>
      }
    >
      <p>
        Scanning the QR on an isolation procedure opens a read-only view — the isolation
        points, the hazards, how to verify each one dead, and which points are locked right
        now — without needing an account. Locking a point still requires signing in.
      </p>
      <p>
        Procedures written before this existed have no published view until something
        changes them. This publishes the rest. It copies no names: the page shows that a
        point is locked, never who locked it.
      </p>
    </Job>
  )
}

/**
 * Register the padlocks that were already on equipment.
 *
 * A padlock is now claimed as one document per lock number, so the same lock
 * cannot be applied to two machines — the claim id IS the number, and Firestore
 * serialises two people writing it. That closes the write path and nothing
 * else: a lock hanging on a machine since before the deploy has no claim, so
 * its number reads as free and the next operator can take it for a different
 * machine. On a plant shutdown the oldest live lockout is weeks old, so the
 * window is not a moment, it is the whole of a maintenance season.
 *
 * A conflict is REPORTED rather than resolved. Two procedures both recording
 * lock 12 is a real disagreement about the physical world, and the right thing
 * to do with it is put it in front of somebody who can walk down and look.
 */
function LockClaims() {
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [done, setDone] = useState(false)

  const run = async (dryRun) => {
    setBusy(dryRun ? 'dry' : 'write')
    try {
      const r = await backfillLockClaims({ dryRun })
      setPreview(r)
      if (!dryRun) {
        setDone(true)
        toast.success(`Registered ${r.written} padlock${r.written === 1 ? '' : 's'}`)
      } else if (r.missing === 0) {
        toast.success('Nothing to do — every applied padlock is already registered')
      }
    } catch (err) {
      reportError(err, { where: 'backfillLockClaims' })
      toast.error(err?.message || 'Failed')
    } finally {
      setBusy('')
    }
  }

  const nothingToDo = preview && preview.missing === 0

  return (
    <Job
      icon={Lock}
      title="Register padlocks already in use"
      result={preview && [
        `${preview.total} padlock${preview.total === 1 ? '' : 's'} recorded as applied`,
        `${preview.present} already registered`,
        `${preview.missing} not yet registered`,
        preview.ids?.length ? `\n${preview.ids.map((i) => `  · ${i}`).join('\n')}` : '',
        preview.clashes?.length
          ? `\n${preview.clashes.length} disagreement${preview.clashes.length === 1 ? '' : 's'} — walk down and check:\n${preview.clashes.map((c) => `  · ${c}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n')}
      actions={
        <>
          <Button variant="ghost" icon={Play} loading={busy === 'dry'} disabled={Boolean(busy)} onClick={() => run(true)}>
            Check first
          </Button>
          <Button
            icon={done ? Check : undefined}
            loading={busy === 'write'}
            disabled={Boolean(busy) || !preview || nothingToDo}
            onClick={() => run(false)}
          >
            {done ? 'Registered' : 'Register them'}
          </Button>
        </>
      }
    >
      <p>
        A padlock can now only be applied to one machine at a time — the system reserves the
        lock number the moment it goes on, and releases it when it comes off. Two people
        reaching for the same lock used to be invisible to it.
      </p>
      <p>
        Locks already hanging on equipment were applied before that reservation existed, so
        their numbers still read as free. This registers them. Anything it cannot reconcile
        is listed rather than guessed at.
      </p>
    </Job>
  )
}

/**
 * Prove error reporting reaches Sentry, from the deployed build.
 *
 * The existing `?__crash=1` hook is gated on import.meta.env.DEV, so it cannot
 * answer the only question that matters — whether errors arrive from
 * PRODUCTION. Without this, configuring the DSN is an act of faith until the
 * first real crash, which is the worst moment to discover a typo in it.
 */
function ErrorReporting() {
  const [sent, setSent] = useState(false)
  const configured = Boolean((import.meta.env.VITE_SENTRY_DSN || '').trim())

  const send = () => {
    // A real Error, through the real funnel — not a synthetic call that would
    // prove a different path works.
    reportError(new Error('Test event from Maintenance — error reporting is wired up'), {
      deliberate: true,
      sentAt: new Date().toISOString(),
    })
    setSent(true)
  }

  return (
    <Job
      icon={Bug}
      title="Check error reporting"
      result={sent && (configured
        ? 'Sent. It should appear in Sentry within a minute — look for "Test event from Maintenance".'
        : 'Logged to this browser console only. No DSN is configured in this build.')}
      actions={
        <Button variant="ghost" icon={sent ? Check : Bug} onClick={send}>
          {sent ? 'Send another' : 'Send a test event'}
        </Button>
      }
    >
      <p>
        {configured
          ? 'Error reporting is configured in this build. Send a test event to confirm it arrives.'
          : 'No error reporting is configured in this build, so crashes are only written to the browser console — nobody finds out unless a user tells you. Set VITE_SENTRY_DSN and redeploy.'}
      </p>
      <p>
        This sends one deliberate error through the same path a real crash takes,
        so it proves the whole funnel rather than just the connection.
      </p>
    </Job>
  )
}

/**
 * Encrypt what was stored before encryption was switched on.
 *
 * Turning it on seals new writes and nothing else, so every record filed before
 * that moment is still in plaintext in the database — and what is already stored
 * IS the exposure. Same reasoning as the three jobs above it, which is why it
 * sits with them.
 *
 * Unlike those, this one runs IN THE BROWSER rather than as a Cloud Function.
 * The reason is in the header of src/shared/crypto/backfill.js and is worth
 * repeating here because it explains the slow progress bar: the field path is
 * bound into every sealed value, so a server-side copy of the policy that
 * drifted by one character would seal records nothing could ever open again.
 * Running it here means there is one implementation and it cannot disagree with
 * itself.
 */
function SealHistory() {
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [at, setAt] = useState('')
  const [done, setDone] = useState(false)

  const run = async (dryRun) => {
    setBusy(dryRun ? 'dry' : 'write')
    setAt('')
    try {
      const r = await backfillAll({ dryRun, onProgress: setAt })
      setPreview(r)
      if (!dryRun) {
        // `remaining` is not a failure — a run is capped so it can finish. Say
        // so, or the second run looks like the first one not having worked.
        setDone(r.remainingTotal === 0 && r.blockedTotal === 0)
        toast.success(`Encrypted ${r.sealedTotal} record${r.sealedTotal === 1 ? '' : 's'}`)
      } else if (r.sealedTotal === 0) {
        toast.success('Nothing to encrypt — every record is already sealed')
      }
    } catch (err) {
      toast.error(err?.message || 'Failed')
      reportError(err, { source: 'maintenance.sealHistory' })
    } finally {
      setBusy('')
      setAt('')
    }
  }

  const nothingToDo = preview && preview.sealedTotal === 0 && preview.remainingTotal === 0
  const blocked = preview?.blockedTotal || 0

  return (
    <Job
      icon={Lock}
      title="Encrypt existing records"
      result={preview && [
        `${preview.scannedTotal} record${preview.scannedTotal === 1 ? '' : 's'} checked`,
        `${preview.sealedTotal} ${preview.dryRun ? 'to encrypt' : 'encrypted'}, ${preview.alreadySealedTotal} already encrypted`,
        '',
        ...preview.results
          .filter((r) => r.scanned || r.sealed)
          .map((r) => `  · ${r.collection}: ${r.sealed} of ${r.scanned}`),
        preview.remainingTotal
          ? `\n  · ${preview.remainingTotal} more than one run may do — run it again to finish`
          : '',
        // Never the field values and never a filename: a report that named what
        // it could not seal would be one more copy of the thing being confined.
        // The collection and the document id find any row and carry nothing
        // clinical — the same rule planMedicalStrip follows.
        blocked ? `\n  ⚠ ${blocked} could not be encrypted and ${blocked === 1 ? 'was' : 'were'} left exactly as ${blocked === 1 ? 'it is' : 'they are'}:` : '',
        ...(blocked ? preview.blocked.slice(0, 20).map((b) => `      ${b.collection} · ${b.id} · ${b.reason}`) : []),
        blocked > 20 ? `      …and ${blocked - 20} more` : '',
      ].filter(Boolean).join('\n')}
      actions={
        <>
          <Button variant="ghost" icon={Play} loading={busy === 'dry'} disabled={Boolean(busy)} onClick={() => run(true)}>
            Check first
          </Button>
          <Button
            icon={done ? Check : undefined}
            loading={busy === 'write'}
            disabled={Boolean(busy) || !preview || nothingToDo}
            onClick={() => run(false)}
          >
            {done ? 'Encrypted' : 'Encrypt them'}
          </Button>
          {busy && at && <span className="self-center text-xs text-ink-500">Reading {at}…</span>}
        </>
      }
    >
      <p>
        Incident narratives, injury and illness records, meeting minutes and drill debriefs
        are encrypted in the browser before they are saved. That applies to records saved
        from now on. Everything filed before it was switched on is still stored in readable
        form, and that is where the risk actually sits — closing the door does nothing about
        what is already through it.
      </p>
      <p>
        Nothing is replaced until it has been decrypted again and checked against the original,
        field by field. A record that fails that check is left exactly as it was and listed
        below, so an interrupted or imperfect run can never leave you with a record nobody
        can read. Running it twice is safe: anything already encrypted is skipped.
      </p>
      <p>
        This runs in this browser tab rather than on the server, so leave the page open until
        it finishes. Large organizations take several runs — the count of what is left is
        reported each time.
      </p>
    </Job>
  )
}

/** Shared shell: title, why it matters, a result panel, and the action. */
function Job({ icon: Icon, title, children, result, actions }) {
  return (
    // Labelled as a region so each job is its own landmark: several of these
    // carry a button called "Check first", and without this neither a screen
    // reader nor a test can tell which one it is looking at.
    <Card role="region" aria-label={title}>
      <div className="mb-1 flex items-center gap-2">
        <Icon size={16} className="shrink-0 text-ink-500" />
        <h2 className="text-sm font-bold text-ink-800">{title}</h2>
      </div>
      <div className="max-w-[62ch] space-y-2 text-xs leading-relaxed text-ink-500">{children}</div>
      {result && (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-ink-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-700">
          {result}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
    </Card>
  )
}

/**
 * Why a row could not be handled, said the way an admin can act on.
 *
 * The reason codes are the whole point of the report and none of them used to
 * reach the screen: this card printed `blockedFields.join(', ')`, and
 * blockedFields is a COUNT, so the line silently rendered nothing and `reason`
 * was never shown at all. A run that reported one blocked row looked, on screen,
 * like a run that had simply found nothing to do.
 */
const BLOCK_REASONS = {
  'no-injury-record': 'no injury record exists yet — run step 1',
  'missing-in-injury': 'the injury record does not hold this detail yet — run step 1',
  'no-person-id': 'the row names no person, so there is no injury record to write to',
  'sign-in-id-only': 'the person is identified only by sign-in id — set the person on the incident first',
  'injury-record-verified': 'the injury record is verified and locked',
  'injury-record-deleted': 'the injury record is in the Recycle Bin',
  'differs-in-injury': 'the injury record says something different — only a person can say which is right',
  // Step 3's reasons. It files each document under the injured person it belongs
  // to, and the old shape never recorded whose it was.
  'several-people': 'more than one person was injured, and nothing says whose document this is',
  'foreign-path': 'the file is stored outside this organization — it will not be touched',
}

/** Blocked rows collapsed to "n × plain english", newest concern first. */
const blockedLines = (rows = []) => {
  const counts = new Map()
  for (const r of rows) counts.set(r.reason, (counts.get(r.reason) || 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `  · ${n} × ${BLOCK_REASONS[reason] || reason}`)
}

