import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Play, Check, Bug, QrCode, Lock, UserCheck, FileDown, MapPin, CloudDownload } from 'lucide-react'
import { Card, Button, Field, Select, Input } from '../../shared/ui'
import { reportError } from '../../shared/monitoring'
import { backfillProcedureMirrors } from '../../modules/loto/services/procedures'
import { backfillLockClaims } from '../../modules/loto/services/lockClaims'
import { backfillAll } from '../../shared/crypto/backfill'
import { backfillCreatorUids } from '../../shared/org/creatorBackfill'
import { backfillSiteIds } from '../../shared/org/siteBackfill'
import { exportSubjectData, migrateLegacyFiles } from '../../shared/functions'
import { logAudit, subscribeOrgUsers } from '../../shared/org/orgData'
import { sealingEnabled } from '../../shared/crypto'
import { useAuth } from '../../shared/auth/AuthContext'

/**
 * Maintenance jobs an administrator runs from the browser. Each is idempotent
 * and runs in this browser against the organization's own server.
 */
export default function Maintenance() {
  return (
    <div className="space-y-4">
      <SubjectAccess />
      <SealHistory />
      <ProcedureMirrors />
      <LockClaims />
      <LegacyFiles />
      <SiteIds />
      <CreatorUids />
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
/**
 * Move files still on Firebase Storage into this deployment's own storage.
 *
 * Run on the server (migrateLegacyFiles in stack/workers.mjs), a batch at a
 * time, because a browser cannot fetch from Firebase Storage across origins
 * and a Worker request has a time limit.
 */
function LegacyFiles() {
  const [busy, setBusy] = useState('')
  const [state, setState] = useState(null)
  const [failed, setFailed] = useState([])

  const run = async (dryRun) => {
    setBusy(dryRun ? 'dry' : 'write')
    try {
      const r = await migrateLegacyFiles({ dryRun })
      setState(r)
      if (!dryRun) {
        setFailed((f) => [...f, ...r.failed])
        toast.success(r.remaining ? `Copied ${r.copied}; ${r.remaining} left — run it again` : 'Every file is copied')
      } else if (r.files === 0) {
        toast.success('Nothing to do — no record links to Firebase Storage')
      }
    } catch (err) {
      reportError(err, { where: 'migrateLegacyFiles' })
      toast.error(err?.message || 'Failed')
    } finally {
      setBusy('')
    }
  }

  const where = state ? Object.entries(state.byCollection || {}).map(([c, n]) => `  ${c}: ${n}`) : []

  return (
    <Job
      icon={CloudDownload}
      title="Move old files off Firebase Storage"
      result={state && [
        `${state.records} record${state.records === 1 ? '' : 's'} link to ${state.files} file${state.files === 1 ? '' : 's'} on Firebase Storage`,
        ...where,
        state.remaining !== undefined && state.copied ? `${state.remaining} still to copy` : '',
        failed.length ? `\nCould not copy (left as they are):\n${failed.slice(0, 8).map((f) => `  ${f.records.join(', ')} — ${f.error}`).join('\n')}` : '',
        state.files === 0 ? '\nNothing links to Firebase Storage any more. Firebase can be removed from the img-src line of the Content-Security-Policy in public/_headers.' : '',
      ].filter(Boolean).join('\n')}
      actions={
        <>
          <Button variant="ghost" icon={Play} loading={busy === 'dry'} disabled={Boolean(busy)} onClick={() => run(true)}>
            Check first
          </Button>
          <Button
            loading={busy === 'write'}
            disabled={Boolean(busy) || !state || state.remaining === 0}
            onClick={() => run(false)}
          >
            Copy next batch
          </Button>
        </>
      }
    >
      <p>
        Photos and documents attached before files moved to this server are still stored on Google
        Firebase Storage, and opening those records loads them from Google. This copies each file
        here and points the record at the copy, 25 files at a time.
      </p>
      <p>
        Encrypted files are copied as they are and stay encrypted. A file that cannot be fetched is
        listed and its record left unchanged.
      </p>
    </Job>
  )
}

/**
 * Record the site on older records that name it only in text.
 *
 * The server restricts a record to the people who reach its site once it has a
 * siteId; until then it is visible to everyone who can see the module. See
 * src/shared/org/siteBackfill.js.
 */
function SiteIds() {
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [done, setDone] = useState(false)

  const run = async (dryRun) => {
    setBusy(dryRun ? 'dry' : 'write')
    try {
      const r = await backfillSiteIds({ dryRun })
      setPreview(r)
      if (!dryRun) {
        setDone(true)
        toast.success(`Recorded the site on ${r.written} record${r.written === 1 ? '' : 's'}`)
      } else if (r.writes.length === 0) {
        toast.success('Nothing to do — every record that can be matched already has its site')
      }
    } catch (err) {
      reportError(err, { where: 'backfillSiteIds' })
      toast.error(err?.message || 'Failed')
    } finally {
      setBusy('')
    }
  }

  const sample = (list) =>
    list.slice(0, 6).map((r) => `    ${r.collection}: "${r.text || '(no site text)'}"`).join('\n')

  return (
    <Job
      icon={MapPin}
      title="Record the site on older records"
      result={preview && [
        `${preview.sited} records already name their site`,
        `${preview.writes.length} can be matched to one site${done ? ` (${preview.written} written)` : ''}`,
        preview.ambiguous.length ? `${preview.ambiguous.length} name more than one site — left alone:\n${sample(preview.ambiguous)}` : '',
        preview.unmatched.length ? `${preview.unmatched.length} match no site — left alone:\n${sample(preview.unmatched)}` : '',
      ].filter(Boolean).join('\n')}
      actions={
        <>
          <Button variant="ghost" icon={Play} loading={busy === 'dry'} disabled={Boolean(busy)} onClick={() => run(true)}>
            Check first
          </Button>
          <Button
            icon={done ? Check : undefined}
            loading={busy === 'write'}
            disabled={Boolean(busy) || !preview || preview.writes.length === 0 || done}
            onClick={() => run(false)}
          >
            {done ? 'Recorded' : 'Record sites'}
          </Button>
        </>
      }
    >
      <p>
        Each record that names a site is shown only to the people who can access that site.
        Older incidents, drills, meetings, permits and equipment name their site in text instead,
        so everyone who can open the module still sees them.
      </p>
      <p>
        This matches that text to one site in your register and records it. Text that fits more
        than one site, or none, is listed and left alone. After this, those records follow the
        same site access as new ones.
      </p>
    </Job>
  )
}

/**
 * Record who wrote older committee meetings and inspection records.
 *
 * An employee may edit a record they created, and the server decides that
 * from a uid. These two kept only a name, so everything saved before the uid
 * existed is editable by managers alone. See src/shared/org/creatorBackfill.js.
 */
function CreatorUids() {
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [done, setDone] = useState(false)

  const run = async (dryRun) => {
    setBusy(dryRun ? 'dry' : 'write')
    try {
      const r = await backfillCreatorUids({ dryRun })
      setPreview(r)
      const total = r.reduce((n, c) => n + (dryRun ? c.matched.length : c.written), 0)
      if (!dryRun) {
        setDone(true)
        toast.success(`Recorded the author of ${total} record${total === 1 ? '' : 's'}`)
      } else if (total === 0) {
        toast.success('Nothing to do — every record that can be matched already has its author')
      }
    } catch (err) {
      reportError(err, { where: 'backfillCreatorUids' })
      toast.error(err?.message || 'Failed')
    } finally {
      setBusy('')
    }
  }

  const toWrite = preview ? preview.reduce((n, c) => n + c.matched.length, 0) : 0
  const list = (names) => [...new Set(names)].slice(0, 8).join(', ')

  return (
    <Job
      icon={UserCheck}
      title="Record who wrote older meetings and inspections"
      result={preview && preview.map((c) => [
        `${c.label}:`,
        `  ${c.already} already record their author`,
        `  ${c.matched.length} can be matched to one person${done ? ` (${c.written} written)` : ''}`,
        c.ambiguous.length ? `  ${c.ambiguous.length} name more than one person: ${list(c.ambiguous)}` : '',
        c.unmatched.length ? `  ${c.unmatched.length} match nobody: ${list(c.unmatched)}` : '',
      ].filter(Boolean).join('\n')).join('\n')}
      actions={
        <>
          <Button variant="ghost" icon={Play} loading={busy === 'dry'} disabled={Boolean(busy)} onClick={() => run(true)}>
            Check first
          </Button>
          <Button
            icon={done ? Check : undefined}
            loading={busy === 'write'}
            disabled={Boolean(busy) || !preview || toWrite === 0 || done}
            onClick={() => run(false)}
          >
            {done ? 'Recorded' : 'Record authors'}
          </Button>
        </>
      }
    >
      <p>
        Employees can edit the records they created. Committee meetings and inspection records
        saved before this change kept only the author&apos;s name, so until now only a manager
        could edit them.
      </p>
      <p>
        This matches each name or email to a person. Where two people share a name it is left
        alone rather than guessed; a manager can still edit those.
      </p>
    </Job>
  )
}

/**
 * A subject access request: everything held about one person, as a JSON file.
 *
 * The server gathers it (exportSubjectData, stack/workers.mjs) for admins and
 * managers only. What comes back has two halves that mean different things —
 * see docs/DATA-RIGHTS.md §2 — and the summary below says which is which, so
 * nobody hands a person the complete half and calls it everything.
 */
function SubjectAccess() {
  const { actor } = useAuth()
  const [people, setPeople] = useState([])
  const [uid, setUid] = useState('')
  const [personId, setPersonId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => subscribeOrgUsers((list) => setPeople(list.sort((a, b) => String(a.name).localeCompare(String(b.name))))), [])

  const gather = async () => {
    setBusy(true)
    try {
      const data = await exportSubjectData({ uid, personId, encryptionOn: sealingEnabled })
      setResult(data)
      const who = people.find((p) => p.uid === uid)?.name || uid || personId
      // The export itself is an access to the person's records, medical ones
      // included, so it goes on the trail like any other.
      await logAudit(actor, 'user.subject_access_export', {
        target: 'user',
        targetId: uid || personId,
        targetLabel: who,
        summary: `Exported the records held about ${who}`,
      })
    } catch (err) {
      reportError(err, { where: 'exportSubjectData' })
      toast.error(err?.message || 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `subject-access-${result.subject.uid || result.subject.personId}-${result.generatedAt.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const counts = result
    ? Object.entries(result.records).filter(([, rows]) => rows.length).map(([path, rows]) => `  ${path}: ${rows.length}`)
    : []

  return (
    <Job
      icon={FileDown}
      title="Subject access request"
      result={result && [
        'Records found by a key (complete for these):',
        ...(counts.length ? counts : ['  none']),
        '',
        `Places to check by hand (names in free text, not searched): ${result.mentions.length} collections, listed in the file`,
        result.scan?.feasible === false ? `Note: ${result.scan.note}` : '',
        result.problems.length ? `\nCould not read: ${result.problems.map((p) => p.path).join(', ')} — the export is incomplete` : '',
      ].filter((l) => l !== '').join('\n')}
      actions={
        <>
          <Button variant="ghost" icon={Play} loading={busy} disabled={busy || (!uid && !personId.trim())} onClick={gather}>
            Gather
          </Button>
          <Button icon={FileDown} disabled={!result} onClick={download}>
            Download JSON
          </Button>
        </>
      }
    >
      <p>
        Everything this organization holds about one person, for a data access request. Choose
        the person, and add their injury person id if they have injury records.
      </p>
      <div className="grid gap-3 pt-1 sm:grid-cols-2">
        <Field label="Person" htmlFor="sar-person">
          <Select id="sar-person" value={uid} onChange={(e) => { setUid(e.target.value); setResult(null) }}>
            <option value="">—</option>
            {people.map((p) => (
              <option key={p.uid} value={p.uid}>{p.name || p.email}</option>
            ))}
          </Select>
        </Field>
        <Field label="Injury person id (optional)" htmlFor="sar-person-id">
          <Input id="sar-person-id" value={personId} onChange={(e) => { setPersonId(e.target.value); setResult(null) }} />
        </Field>
      </div>
      <p>
        The file has two halves. Records joined by a key are complete. Names written in free text
        (meeting attendees, people named in an incident) cannot be searched reliably, so the file
        lists where to look instead of claiming none were found.
      </p>
    </Job>
  )
}

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



