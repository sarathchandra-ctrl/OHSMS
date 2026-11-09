import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { doc, getDoc } from '../../shared/data/client.js'
import toast from 'react-hot-toast'
import { AlertTriangle, ClipboardCheck, Loader2, PackageCheck, QrCode, Wrench } from 'lucide-react'
import { db } from '../../shared/db'
import { useAuth } from '../../shared/auth/AuthContext'
import { toastCaught } from '../../shared/lib/toastCaught'
import { tokenFromQrValue } from '../../modules/fire/lib/qr'
import { DEFECTS, DEFECT_BY_KEY } from '../../modules/fire/lib/constants'
import {
  createReport,
  serviceAed,
  serviceFas,
  serviceStretcher,
} from '../../modules/fire/lib/firestore'
import { retiredQrCopy } from '../../modules/fire/lib/recycle'
import ReportDefectModal from '../../modules/fire/components/ReportDefectModal'
import ReportAssetDefectModal from '../../modules/fire/components/ReportAssetDefectModal'
import ReceiveFromVendorModal from '../../modules/fire/components/ReceiveFromVendorModal'
import CloseDefectModal from '../../modules/fire/components/CloseDefectModal'
import { Field } from '../../shared/ui'
import {
  assetCard,
  assetKindOf,
  assetRecordId,
  fieldQuickActions,
  validateNextDue,
} from './quickActions'
import { loadAssetRecord } from './loadAsset'

const SERVICE = {
  aed: serviceAed,
  fas: serviceFas,
  stretcher: serviceStretcher,
}

function extinguisherLabel(mirror) {
  if (mirror?.serialNo) return `${mirror.serialNo} · ${mirror.type || ''}`.trim()
  return `${mirror?.type || ''} · ${mirror?.capacity || ''}`.trim()
}

export default function Asset() {
  const { token: rawToken } = useParams()
  const token = tokenFromQrValue(rawToken)
  const { orgId, orgName, role, profile, actor } = useAuth()
  const [mirror, setMirror] = useState(undefined)
  const [mode, setMode] = useState(null)
  const [record, setRecord] = useState(null)
  const [checks, setChecks] = useState({})
  const [note, setNote] = useState('')
  const [nextDue, setNextDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(null)

  const reload = () => {
    if (!token || !db) {
      setMirror(null)
      return undefined
    }
    let alive = true
    getDoc(doc(db, 'qr', token))
      .then((snap) => {
        if (alive) setMirror(snap.exists() ? { id: snap.id, ...snap.data() } : null)
      })
      .catch(() => {
        if (alive) setMirror(null)
      })
    return () => {
      alive = false
    }
  }

  useEffect(() => {
    setMirror(undefined)
    setMode(null)
    return reload()
    // token is the only input. reload closes over the latest db, which does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  if (!token) {
    return <Notice title="Code not recognised" body="This QR code is not an equipment label." />
  }
  if (mirror === undefined) {
    return (
      <div className="grid min-h-[40vh] place-items-center" role="status">
        <Loader2 size={28} className="animate-spin text-brand-600" aria-hidden="true" />
        <span className="sr-only">Looking up this code</span>
      </div>
    )
  }
  if (mirror === null) {
    return (
      <Notice
        title="Code not recognised"
        body="This QR code does not match any equipment on record. It may belong to another system, or the asset may have been removed."
      />
    )
  }

  const decision = fieldQuickActions(mirror, { role, orgId })
  const card = assetCard(mirror)

  if (decision.state === 'retired') {
    const copy =
      mirror.assetKind === 'stretcher'
        ? {
            title: 'This stretcher was deleted',
            detail:
              'It is not in service. It can be restored for 30 days; until then this sticker will not open an inspection.',
          }
        : retiredQrCopy(mirror)
    return (
      <Notice title={copy.title} body={copy.detail}>
        <Link to={`/qr/${token}`} className="btn-ghost mt-4 min-h-12 w-full">
          Open the sticker page
        </Link>
      </Notice>
    )
  }

  if (decision.state === 'foreign') {
    const theirs = mirror.orgName
      ? `This code belongs to ${mirror.orgName}. `
      : 'This code belongs to a different organisation. '
    const yours = orgName ? `You are signed in to ${orgName}. ` : ''
    return (
      <Notice
        title="Another organisation"
        body={`${theirs}${yours}Nothing here can change their records.`}
      />
    )
  }

  if (decision.state === 'unscoped') {
    return (
      <Notice
        title="Code not linked to an organisation"
        body="This label has no organisation stamped on it, so it cannot be matched to your sites. An administrator can repair QR codes from Maintenance."
      />
    )
  }

  const openInspect = async () => {
    setChecks({})
    setNote('')
    setNextDue('')
    if (card.kind === 'extinguisher') {
      setMode('inspect')
      return
    }
    setBusy(true)
    try {
      const loaded = await loadAssetRecord(orgId, card.kind, assetRecordId(mirror))
      if (!loaded) {
        toast.error(
          'The unit record could not be opened. The label may predate the current register.'
        )
        return
      }
      setRecord(loaded)
      setMode('inspect')
    } catch (err) {
      toastCaught(err, 'Could not open the unit')
    } finally {
      setBusy(false)
    }
  }

  const openReceive = async () => {
    setBusy(true)
    try {
      const loaded = await loadAssetRecord(orgId, 'extinguisher', assetRecordId(mirror))
      if (!loaded) {
        toast.error('The extinguisher record could not be opened.')
        return
      }
      setRecord(loaded)
      setMode('receive')
    } catch (err) {
      toastCaught(err, 'Could not open the unit')
    } finally {
      setBusy(false)
    }
  }

  const run = (key) => {
    if (key === 'inspect') return openInspect()
    if (key === 'defect') return setMode('defect')
    if (key === 'receive') return openReceive()
    if (key === 'close') {
      if (card.kind === 'extinguisher') return setMode('close')
      return setMode('close-asset')
    }
    return undefined
  }

  const submitInspection = async () => {
    if (card.kind !== 'extinguisher') {
      const error = validateNextDue(nextDue)
      if (error) return toast.error(error)
      const service = SERVICE[card.kind]
      if (!service || !record) return toast.error('This unit cannot be inspected from here.')
      setBusy(true)
      try {
        await service(orgId, orgName, { ...record, qrToken: record.qrToken || token }, nextDue, {
          uid: profile?.uid,
          name: profile?.name,
        })
        toast.success('Inspection logged')
        setMode(null)
        reload()
      } catch (err) {
        toastCaught(err, 'Could not log the inspection')
      } finally {
        setBusy(false)
      }
      return
    }

    const unanswered = DEFECTS.filter(
      (item) => checks[item.key] !== 'ok' && checks[item.key] !== 'bad'
    )
    if (unanswered.length) return toast.error('Mark every item OK or not OK')
    const failed = DEFECTS.filter((item) => checks[item.key] === 'bad')
    if (!failed.length) {
      toast.success('No defects to report')
      setMode(null)
      return
    }
    const id = assetRecordId(mirror)
    if (!id) return toast.error('This label has no unit id, so the defect cannot be filed.')
    setBusy(true)
    try {
      for (const item of failed) {
        await createReport(orgId, {
          extId: id,
          extLabel: extinguisherLabel(mirror),
          kind: 'defect',
          defectType: item.key,
          token,
          note,
          reportedBy: profile?.uid || actor?.uid || '',
          reportedByName: profile?.name || actor?.name || '',
          source: 'portal',
        })
      }
      toast.success(
        failed.length === 1
          ? 'Defect reported — pending approval'
          : `${failed.length} defects reported — pending approval`
      )
      setMode(null)
      reload()
    } catch (err) {
      toastCaught(err, 'Could not report the defect')
    } finally {
      setBusy(false)
    }
  }

  const closeRow = (key) => ({
    defect: DEFECT_BY_KEY[key]?.label || key,
    label: mirror.serialNo || card.title,
    source: 'physical',
    raw: {
      defectType: key,
      extId: assetRecordId(mirror),
      serialNo: mirror.serialNo || '',
      type: mirror.type || '',
      capacity: mirror.capacity || '',
      centerName: mirror.centerName || '',
      region: mirror.region || '',
      entity: mirror.entity || '',
      location: mirror.location || '',
    },
  })

  return (
    <div className="mx-auto max-w-md">
      <article className="card overflow-hidden !p-0">
        <header className="bg-brand-600 p-5 text-white">
          <p className="text-xs font-bold uppercase tracking-widest">{card.eyebrow}</p>
          <h1 className="mt-1 text-xl font-bold">{card.title}</h1>
          {card.subtitle && <p className="mt-0.5 text-sm">{card.subtitle}</p>}
          {card.where && <p className="mt-2 text-sm">{card.where}</p>}
        </header>
        {card.defects?.length > 0 && (
          <p className="mx-5 my-4 rounded-2xl bg-red-50 px-3 py-3 text-sm text-red-900">
            Open: {card.defects.join(', ')}
          </p>
        )}
        <div className="grid gap-2 p-5">
          {decision.actions.length === 0 && (
            <p className="text-sm text-ink-500">
              You can view this unit. Your role cannot change it.
            </p>
          )}
          {decision.actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="btn-primary min-h-12 w-full"
              onClick={() => run(action.key)}
              disabled={busy}
            >
              <ActionIcon name={action.key} /> {action.label}
            </button>
          ))}
        </div>
      </article>

      {mode === 'inspect' && card.kind === 'extinguisher' && (
        <section className="mt-4 card p-5" aria-labelledby="inspect-heading">
          <h2 id="inspect-heading" className="text-base font-bold text-ink-900">
            Visual inspection
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            A clean check files nothing. Anything you mark not OK goes to the approval queue.
          </p>
          <ul className="mt-4 grid gap-3">
            {DEFECTS.map((item) => (
              <li key={item.key} className="rounded-2xl bg-surface-50 p-3 ring-1 ring-ink-200">
                <p className="text-sm font-semibold text-ink-900">{item.label}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Choice
                    on={checks[item.key] === 'ok'}
                    onClick={() => setChecks((c) => ({ ...c, [item.key]: 'ok' }))}
                  >
                    OK
                  </Choice>
                  <Choice
                    on={checks[item.key] === 'bad'}
                    onClick={() => setChecks((c) => ({ ...c, [item.key]: 'bad' }))}
                    tone="bad"
                  >
                    Not OK
                  </Choice>
                </div>
              </li>
            ))}
          </ul>
          <Field label="Note (optional)" className="mt-4">
            <textarea
              className="input min-h-20"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <div className="mt-4 grid gap-2">
            <button
              type="button"
              className="btn-primary min-h-12 w-full"
              onClick={submitInspection}
              disabled={busy}
            >
              {busy ? 'Sending…' : 'Save inspection'}
            </button>
            <button
              type="button"
              className="btn-ghost min-h-12 w-full"
              onClick={() => setMode(null)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {mode === 'inspect' && card.kind !== 'extinguisher' && (
        <section className="mt-4 card p-5" aria-labelledby="service-heading">
          <h2 id="service-heading" className="text-base font-bold text-ink-900">
            Log inspection
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Last {card.kind === 'fas' ? 'service' : 'inspection'} is set to today and the unit is
            marked ready.
          </p>
          <Field
            label={card.kind === 'fas' ? 'Next service due' : 'Next inspection due'}
            className="mt-4"
          >
            <input
              type="date"
              className="input"
              value={nextDue}
              onChange={(e) => setNextDue(e.target.value)}
            />
          </Field>
          <div className="mt-4 grid gap-2">
            <button
              type="button"
              className="btn-primary min-h-12 w-full"
              onClick={submitInspection}
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Log inspection'}
            </button>
            <button
              type="button"
              className="btn-ghost min-h-12 w-full"
              onClick={() => setMode(null)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {mode === 'close' && (
        <section className="mt-4 card p-5" aria-labelledby="close-heading">
          <h2 id="close-heading" className="text-base font-bold text-ink-900">
            Close a defect
          </h2>
          <ul className="mt-3 grid gap-2">
            {(mirror.physicalDefects || []).map((key) => (
              <li key={key}>
                <button
                  type="button"
                  className="btn-ghost min-h-12 w-full"
                  onClick={() => setClosing(closeRow(key))}
                >
                  Close {DEFECT_BY_KEY[key]?.label || key}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn-ghost mt-3 min-h-12 w-full"
            onClick={() => setMode(null)}
          >
            Cancel
          </button>
        </section>
      )}

      {mode === 'close-asset' && (
        <section className="mt-4 card p-5">
          <h2 className="text-base font-bold text-ink-900">Close defect</h2>
          <p className="mt-1 text-sm text-ink-500">
            Closing an {card.eyebrow} fault is done from the defect list, which has the report the
            close is filed against.
          </p>
          <Link to="/equipment/defects" className="btn-primary mt-4 min-h-12 w-full">
            Open defects
          </Link>
          <button
            type="button"
            className="btn-ghost mt-2 min-h-12 w-full"
            onClick={() => setMode(null)}
          >
            Cancel
          </button>
        </section>
      )}

      <p className="mt-4 text-center">
        <Link to="/field/scan" className="text-sm font-semibold text-brand-700">
          Scan another
        </Link>
      </p>

      {card.kind === 'extinguisher' ? (
        <ReportDefectModal
          open={mode === 'defect'}
          onClose={() => setMode(null)}
          ext={{ ...mirror, extId: assetRecordId(mirror), qrToken: token }}
          orgId={orgId}
          reporter={{ uid: profile?.uid, name: profile?.name }}
          source="portal"
        />
      ) : (
        <ReportAssetDefectModal
          open={mode === 'defect'}
          onClose={() => setMode(null)}
          asset={{ ...mirror, token }}
          kind={assetKindOf(mirror)}
        />
      )}

      <ReceiveFromVendorModal
        open={mode === 'receive'}
        onClose={() => {
          setMode(null)
          reload()
        }}
        ext={record}
        orgId={orgId}
        orgName={orgName}
        actorName={profile?.name || actor?.name || ''}
      />

      <CloseDefectModal
        open={Boolean(closing)}
        onClose={() => {
          setClosing(null)
          setMode(null)
          reload()
        }}
        row={closing}
        orgId={orgId}
        orgName={orgName}
        actor={{ uid: profile?.uid || actor?.uid, name: profile?.name || actor?.name }}
      />
    </div>
  )
}

function ActionIcon({ name }) {
  const Icon =
    name === 'inspect'
      ? ClipboardCheck
      : name === 'receive'
        ? PackageCheck
        : name === 'close'
          ? Wrench
          : AlertTriangle
  return <Icon size={18} aria-hidden="true" />
}

function Choice({ on, onClick, children, tone }) {
  const selected = on
    ? tone === 'bad'
      ? 'bg-red-600 text-white'
      : 'bg-brand-600 text-white'
    : 'bg-white text-ink-800 ring-1 ring-ink-200'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-12 rounded-2xl px-3 text-sm font-semibold ${selected}`}
    >
      {children}
    </button>
  )
}

function Notice({ title, body, children }) {
  return (
    <div className="mx-auto max-w-md">
      <div className="card p-8 text-center">
        <QrCode size={32} className="mx-auto text-ink-300" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-bold text-ink-900">{title}</h1>
        <p className="mt-1 text-sm text-ink-500">{body}</p>
        {children}
      </div>
      <p className="mt-4 text-center">
        <Link to="/field/scan" className="text-sm font-semibold text-brand-700">
          Scan another
        </Link>
      </p>
    </div>
  )
}
