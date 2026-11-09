import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useReactToPrint } from 'react-to-print'
import { motion } from 'framer-motion'
import {
  ArrowLeft, Printer, FileText, MapPin, Calendar, Phone, User, Building2, ShieldAlert, HardHat,
  ListChecks, Users as UsersIcon, CheckCircle2, XCircle, Clock, Lock, TimerReset, MessageSquarePlus,
  Table, Paperclip, Download, Flame, Eye, X, QrCode, AlertTriangle, Trash2,
} from 'lucide-react'
import { QRCodeCanvas } from 'qrcode.react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Spinner, Modal, Field, EmptyState } from '../components/ui'
import StatusBadge from '../components/StatusBadge'
import PermitPrintable from '../components/PermitPrintable'
import { useAuth } from '../context/AuthContext'
import { usePermits } from '../context/PermitContext'
import {
  decideApproval, requestClosure, decideClosure, requestExtension, addExtensionSuggestion, decideExtension,
  subscribePermitDocuments, addPermitDocument, deletePermitDocument,
  ensurePermitQr, subscribePermitObservations, createObservation, deletePermit,
} from '../lib/firestore'
import { can, canActForTeam, TEAMS } from '../lib/permissions'
import { STATUS, statusMeta } from '../lib/permitStatus'
import { fileToDataUrl, formatBytes } from '../lib/files'
import { publicPermitUrl } from '../lib/qr'
import { safeHref } from '../../../shared/safeUrl'
import { readableOnTint } from '../../../shared/lib/contrast'

const fmt = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
const toLocalInput = (iso) => {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16)
}

function DecisionState({ block }) {
  const s = block?.status || 'pending'
  const map = {
    approved: { icon: CheckCircle2, color: '#16a34a', label: 'Approved' },
    rejected: { icon: XCircle, color: '#dc2626', label: 'Rejected' },
    pending: { icon: Clock, color: '#a16207', label: 'Pending' },
  }
  const m = map[s]
  const Icon = m.icon
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: m.color }}>
      <Icon size={16} /> {m.label}{block?.byName ? ` · ${block.byName}` : ''}
    </span>
  )
}

function Chips({ items }) {
  if (!items?.length) return <p className="text-sm text-ink-400">None</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => <span key={t} className="chip bg-surface text-ink-600">{t}</span>)}
    </div>
  )
}

/** A team approval row with Approve/Reject when the current user may act. */
function TeamRow({ label, block, actionable, onApprove, onReject }) {
  return (
    <div className="ring-1 ring-ink-200 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-surface-50 px-4 py-3 ">
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-ink-500">{label}</p>
        <DecisionState block={block} />
        {block?.note ? <p className="mt-0.5 text-xs text-ink-500">“{block.note}”</p> : null}
      </div>
      {actionable && block?.status === 'pending' && (
        <div className="flex gap-2">
          <button className="btn-soft" onClick={onApprove}><CheckCircle2 size={15} /> Approve</button>
          <button className="btn-danger" onClick={onReject}><XCircle size={15} /> Reject</button>
        </div>
      )}
    </div>
  )
}

export default function PermitDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile } = useAuth()
  const { permits, loading } = usePermits()
  const printRef = useRef(null)

  const permit = useMemo(() => permits.find((p) => p.id === id), [permits, id])

  const [decision, setDecision] = useState(null) // {stage, team, decision}
  const [note, setNote] = useState('')
  const [closing, setClosing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmNo, setConfirmNo] = useState('')
  const [extOpen, setExtOpen] = useState(false)
  const [extForm, setExtForm] = useState({ reason: '', newValidTo: '', participantChanges: '', riskChanges: '' })
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggest, setSuggest] = useState({ text: '', newValidTo: '' })
  const [busy, setBusy] = useState(false)
  const [documents, setDocuments] = useState([])
  const [observations, setObservations] = useState([])
  const [obsOpen, setObsOpen] = useState(false)
  const [obs, setObs] = useState({ type: 'safe', note: '' })
  const docInputRef = useRef(null)
  const qrEnsuredRef = useRef(false)

  useEffect(() => {
    if ((!id)) return undefined
    const u1 = subscribePermitDocuments(id, setDocuments)
    const u2 = subscribePermitObservations(id, setObservations)
    return () => { u1(); u2() }
  }, [id])

  // Ensure this permit has a QR token + a current public mirror (self-heals
  // permits whose mirror write was previously blocked). Once per permit id.
  useEffect(() => {
    if ((!permit)) return
    if (qrEnsuredRef.current === permit.id) return
    qrEnsuredRef.current = permit.id
    ensurePermitQr(profile.orgName, permit).catch(() => {})
  }, [profile?.orgName, permit])

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: permit ? `${permit.permitNo}` : 'permit',
  })

  if (loading) return <div className="grid place-items-center py-24"><Spinner size={28} /></div>
  if (!permit) {
    return <EmptyState icon={FileText} title="Permit not found" hint="It may have been removed."
      action={<Link to="/permits" className="btn-primary mt-1">Back to permits</Link>} />
  }

  const actor = { uid: user.uid, name: profile?.name || '', orgName: profile?.orgName || '', role: profile?.role }
  const bothApproved = permit.engineering?.status === 'approved' && permit.operations?.status === 'approved'
  const isClosed = permit.status === STATUS.CLOSED || permit.status === STATUS.CLOSED_NONCOMPLIANCE
  const isExpired = permit.status === STATUS.NOT_CLOSED
  const canRequestClosure = can(profile, 'requestClosure', permit) && bothApproved && !permit.closure && !isClosed
  // An expired (Not Closed) permit may still be extended to resume the work —
  // extension is explicitly allowed past the timeline.
  const canRequestExtension = can(profile, 'requestExtension', permit) && bothApproved && !permit.extension && !isClosed
  const isOwner = permit.createdBy === profile?.uid
  const canManageDocs = (can(profile, 'edit', permit) || isOwner) && !isClosed
  const canRemoveDocs = can(profile, 'decide') // approvers/admin
  const canDelete = can(profile, 'delete', permit)

  const run = async (fn) => {
    setBusy(true)
    try { await fn() } catch (e) { toastCaught(e, 'Action failed') } finally { setBusy(false) }
  }

  const onAddDocument = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const f = await fileToDataUrl(file)
      await addPermitDocument(permit.id, { key: 'extra', label: f.name, mandatory: false, fileName: f.name, fileType: f.type, fileData: f.dataUrl, size: f.size }, actor)
      toast.success('Document attached')
    } catch (err) { toastCaught(err) }
  }
  const onRemoveDocument = (d) => run(async () => {
    await deletePermitDocument(permit.id, d.id, actor, d.label || d.fileName)
    toast.success('Document removed')
  })

  const submitObservation = () => run(async () => {
    await createObservation({
      permitId: permit.id, permitNo: permit.permitNo, token: permit.qrToken, type: obs.type, note: obs.note, source: 'portal',
    }, actor)
    toast.success(obs.type === 'unsafe' ? 'Logged — permit closed for non-compliance' : 'Safe observation logged')
    setObsOpen(false)
  })

  const confirmDecision = async () => {
    const { stage, team, decision: d } = decision
    await run(async () => {
      if (stage === 'permit') await decideApproval(permit.id, team, d, note, actor)
      else if (stage === 'closure') await decideClosure(permit.id, team, d, note, actor)
      else if (stage === 'extension') await decideExtension(permit.id, team, d, note, actor)
      toast.success(`${d === 'approved' ? 'Approved' : 'Rejected'}`)
      setDecision(null); setNote('')
    })
  }

  const onDelete = () => run(async () => {
    // Guarded twice: the button only exists for admins, and the modal will not
    // enable this until the permit number has been typed back.
    if (confirmNo.trim() !== permit.permitNo) throw new Error('Permit number does not match')
    await deletePermit(permit, actor)
    toast.success(`Deleted permit ${permit.permitNo}`)
    setDeleting(false)
    navigate('/permits')
  })

  const submitClosure = () => run(async () => {
    await requestClosure(permit.id, actor); toast.success('Submitted for closure'); setClosing(false)
  })

  const submitExtension = () => run(async () => {
    if (!extForm.reason.trim()) throw new Error('Enter a reason for the extension')
    if (!extForm.newValidTo) throw new Error('Choose a new end date & time')
    if (Date.parse(extForm.newValidTo) <= Date.now()) throw new Error('The new end time must be in the future')
    await requestExtension(permit.id, {
      ...extForm,
      newValidTo: new Date(extForm.newValidTo).toISOString(),
    }, actor)
    toast.success('Extension requested'); setExtOpen(false)
  })

  const submitSuggestion = () => run(async () => {
    await addExtensionSuggestion(permit.id, {
      text: suggest.text,
      newValidTo: suggest.newValidTo ? new Date(suggest.newValidTo).toISOString() : null,
    }, actor)
    toast.success('Suggestion added'); setSuggestOpen(false); setSuggest({ text: '', newValidTo: '' })
  })

  const meta = statusMeta(permit.status)

  // Open the extension modal, prefilling a sensible new end (later of now / current validTo).
  const openExtension = () => {
    const base = Math.max(Date.now(), Date.parse(permit.validTo) || 0)
    setExtForm({ reason: '', newValidTo: toLocalInput(new Date(base).toISOString()), participantChanges: '', riskChanges: '' })
    setExtOpen(true)
  }

  // Decision rows actionability
  const engAction = canActForTeam(profile, permit, TEAMS.ENGINEERING)
  const opsAction = canActForTeam(profile, permit, TEAMS.OPERATIONS)
  const openDecision = (stage, team, d) => { setDecision({ stage, team, decision: d }); setNote('') }

  return (
    <div>
      {/* Header */}
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/permits')} className="rounded-xl p-2 shadow-elev-sm transition hover:bg-surface-100 active:bg-surface-100"><ArrowLeft size={18} /></button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">{permit.permitNo}</h1>
              <StatusBadge status={permit.status} />
            </div>
            <p className="text-sm text-ink-500">{permit.typeOfWork} · raised by {permit.createdByName || '—'}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={handlePrint}><Printer size={16} /> Print / PDF</button>
          {canRequestExtension && <button className="btn-ghost" onClick={openExtension}><TimerReset size={16} /> Request Extension</button>}
          {canRequestClosure && <button className="btn-primary" onClick={() => setClosing(true)}><Lock size={16} /> Request Closure</button>}
          {canDelete && <button className="btn-danger" onClick={() => setDeleting(true)}><Trash2 size={16} /> Delete</button>}
        </div>
      </div>

      {/* Status banner */}
      <div className="no-print mb-5 flex items-center gap-3 rounded-2xl px-4 py-3 text-white" style={{ backgroundColor: meta.color }}>
        <ShieldAlert size={18} />
        <span className="font-semibold">{meta.label}</span>
        <span className="ml-auto text-sm text-white/85">Valid {fmt(permit.validFrom)} → {fmt(permit.validTo)}</span>
      </div>

      {/* Expired → prompt for extension */}
      {isExpired && (
        <div className="no-print mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
          <TimerReset size={18} className="text-red-600" />
          <span className="text-sm font-semibold text-red-700">This permit has passed its validity window.</span>
          <span className="text-sm text-red-600">Request an extension to resume the work, or it must be closed.</span>
          {canRequestExtension ? (
            <button className="btn-primary ml-auto" onClick={openExtension}><TimerReset size={16} /> Request Extension</button>
          ) : (
            <span className="ml-auto text-xs text-red-500">Ask the permit raiser or an approver to request an extension.</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Left: details */}
        <div className="space-y-5 lg:col-span-2">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-5">
            <h2 className="mb-3 text-base font-bold text-ink-900">Work details</h2>
            <div className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-2">
              <Detail icon={Calendar} label="Date / time" value={`${permit.date} ${permit.time}`} />
              {permit.site && <Detail icon={MapPin} label="Site" value={permit.site} />}
              <Detail icon={MapPin} label="Location" value={permit.jobLocation} />
              <Detail icon={Building2} label="Issuing dept" value={permit.issuingDepartment} />
              <Detail icon={User} label="Issued to" value={permit.issuedToName} />
              <Detail icon={Phone} label="Phone" value={permit.issuedToPhone} />
            </div>
            <p className="mt-3 text-xs font-bold uppercase tracking-wide text-ink-500">Description</p>
            <p className="text-sm text-ink-700">{permit.jobDescription || '—'}</p>
          </motion.div>

          {permit.jsa?.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-ink-900"><Table size={18} className="text-brand-600" /> Job Safety Analysis</h2>
              <div className="ring-1 ring-ink-200 overflow-x-auto rounded-2xl ">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-surface-100 text-left text-xs uppercase tracking-wide text-ink-500">
                      <th className="px-3 py-2 font-bold">Activity step</th>
                      <th className="px-3 py-2 font-bold">Hazard</th>
                      <th className="px-3 py-2 font-bold">Precaution</th>
                    </tr>
                  </thead>
                  <tbody className="bg-surface">
                    {permit.jsa.map((r, i) => (
                      <tr key={i} className="border-t border-surface-100 align-top">
                        <td className="px-3 py-2 text-ink-800">{r.step || '—'}</td>
                        <td className="px-3 py-2 text-ink-700">{r.hazard || '—'}</td>
                        <td className="px-3 py-2 text-ink-700">{r.precaution || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-ink-900"><ShieldAlert size={18} className="text-brand-600" /> Hazards</h2>
            <Chips items={permit.hazards} />
          </div>
          <div className="card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-ink-900"><HardHat size={18} className="text-brand-600" /> PPE required</h2>
            <Chips items={permit.ppe} />
          </div>
          <div className="card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-ink-900"><ListChecks size={18} className="text-brand-600" /> Precautions</h2>
            <Chips items={permit.precautions} />
          </div>
          <div className="card p-5">
            <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-ink-900"><UsersIcon size={18} className="text-brand-600" /> Participants</h2>
            {permit.participants?.length ? (
              <div className="space-y-1.5">
                {permit.participants.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-ink-700">
                    {p.type === 'internal' ? <User size={14} className="text-ink-400" /> : <Building2 size={14} className="text-ink-400" />}
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-ink-400">{p.company ? `· ${p.company}` : ''} {p.contact ? `· ${p.contact}` : ''}</span>
                    <span className="chip ml-auto bg-surface text-ink-500">{p.type}</span>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-ink-400">None</p>}
          </div>

          {permit.fireWatchers?.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-ink-900"><Flame size={18} className="text-brand-600" /> Fire watcher(s)</h2>
              <div className="space-y-1.5">
                {permit.fireWatchers.map((w, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-ink-700">
                    <span className="font-semibold">{w.name}</span>
                    {w.details && <span className="text-ink-400">· {w.details}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {permit.confinedWatcher?.name && (
            <div className="card p-5">
              <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-ink-900"><Eye size={18} className="text-brand-600" /> Standby watcher / attendant</h2>
              <p className="text-sm text-ink-700"><span className="font-semibold">{permit.confinedWatcher.name}</span>{permit.confinedWatcher.details ? ` · ${permit.confinedWatcher.details}` : ''}</p>
            </div>
          )}

          {/* Documents */}
          <div className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-bold text-ink-900"><Paperclip size={18} className="text-brand-600" /> Documents</h2>
              {canManageDocs && (
                <button className="btn-ghost" onClick={() => docInputRef.current?.click()}><Paperclip size={14} /> Attach</button>
              )}
              <input ref={docInputRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={onAddDocument} />
            </div>

            {/* Required checklist */}
            {permit.requiredDocs?.length > 0 && (
              <div className="mb-3 space-y-1.5">
                {permit.requiredDocs.map((req) => {
                  const file = documents.find((d) => d.key === req.key)
                  return (
                    <div key={req.key} className="flex items-center gap-2 text-sm">
                      {file ? <CheckCircle2 size={15} className="shrink-0 text-green-600" /> : <XCircle size={15} className="shrink-0 text-ink-300" />}
                      <span className={file ? 'text-ink-800' : 'text-ink-500'}>{req.label}</span>
                      {req.mandatory && !file && <span className="chip bg-red-50 text-red-600">Missing</span>}
                      {file && (
                        <a href={safeHref(file.fileData)} download={file.fileName} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline">
                          <Download size={13} /> {formatBytes(file.size)}
                        </a>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Extra / other documents */}
            {documents.filter((d) => d.key === 'extra').length > 0 && (
              <div className="space-y-1.5 border-t border-surface-100 pt-3">
                {documents.filter((d) => d.key === 'extra').map((d) => (
                  <div key={d.id} className="flex items-center gap-2 text-sm">
                    <FileText size={15} className="shrink-0 text-ink-400" />
                    <span className="truncate text-ink-800">{d.fileName}</span>
                    <a href={safeHref(d.fileData)} download={d.fileName} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"><Download size={13} /> {formatBytes(d.size)}</a>
                    {canRemoveDocs && <button onClick={() => onRemoveDocument(d)} className="rounded-lg p-1 text-ink-400 hover:text-red-600"><X size={14} /></button>}
                  </div>
                ))}
              </div>
            )}

            {documents.length === 0 && (!permit.requiredDocs || permit.requiredDocs.length === 0) && (
              <p className="text-sm text-ink-400">No documents attached.</p>
            )}
          </div>

          {/* Observations */}
          <div className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-bold text-ink-900"><Eye size={18} className="text-brand-600" /> Observations</h2>
              {!isClosed && !isExpired && permit.status !== STATUS.CLOSED_NONCOMPLIANCE && (
                <button className="btn-ghost" onClick={() => { setObs({ type: 'safe', note: '' }); setObsOpen(true) }}><Eye size={14} /> Log</button>
              )}
            </div>
            {observations.length === 0 ? (
              <p className="text-sm text-ink-400">No observations logged.</p>
            ) : (
              <div className="space-y-2">
                {observations.map((o) => {
                  const unsafe = o.type === 'unsafe'
                  const color = unsafe ? '#991b1b' : '#16a34a'
                  return (
                    <div key={o.id} className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 ">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="chip" style={{ backgroundColor: `${color}1a`, color: readableOnTint(color) }}>{unsafe ? 'Unsafe' : 'Safe'}</span>
                        <span className="text-ink-500">{o.observedByName}</span>
                        <span className="ml-auto text-xs text-ink-400">{o.source === 'qr' ? 'QR' : 'Portal'}</span>
                      </div>
                      {o.note && <p className="mt-1.5 text-sm text-ink-700">{o.note}</p>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: workflow */}
        <div className="space-y-5">
          {/* QR */}
          <div className="card p-5 text-center">
            <h2 className="mb-3 flex items-center justify-center gap-2 text-base font-bold text-ink-900"><QrCode size={18} className="text-brand-600" /> Scan QR</h2>
            {permit.qrToken ? (
              <>
                <div className="ring-1 ring-ink-200 mx-auto w-fit rounded-2xl bg-white p-3 ">
                  <QRCodeCanvas value={publicPermitUrl(permit.qrToken)} size={150} level="M" includeMargin />
                </div>
                <p className="mt-3 text-xs text-ink-500">Scan to view this permit & log a safety observation.</p>
              </>
            ) : (
              <div className="grid place-items-center py-8 text-ink-400"><Spinner size={22} /></div>
            )}
          </div>

          <div className="card p-5">
            <h2 className="mb-3 text-base font-bold text-ink-900">Approvals</h2>
            <p className="mb-3 text-xs text-ink-500">Both Engineering and Operations must approve before work may begin.</p>
            <div className="space-y-2.5">
              <TeamRow label="Engineering" block={permit.engineering} actionable={engAction && !permit.closure}
                onApprove={() => openDecision('permit', TEAMS.ENGINEERING, 'approved')}
                onReject={() => openDecision('permit', TEAMS.ENGINEERING, 'rejected')} />
              <TeamRow label="Operations" block={permit.operations} actionable={opsAction && !permit.closure}
                onApprove={() => openDecision('permit', TEAMS.OPERATIONS, 'approved')}
                onReject={() => openDecision('permit', TEAMS.OPERATIONS, 'rejected')} />
            </div>
            {(permit.assignedEngineer || permit.assignedOperator) && (
              <p className="mt-3 text-xs text-ink-400">A specific approver is assigned for one or both teams.</p>
            )}
          </div>

          {permit.extension && (
            <div className="card p-5">
              <h2 className="mb-2 flex items-center gap-2 text-base font-bold text-ink-900"><TimerReset size={18} className="text-brand-600" /> Extension</h2>
              <div className="ring-1 ring-ink-200 mb-3 space-y-1 rounded-2xl bg-surface-50 p-3 text-sm ">
                <p><span className="text-ink-500">Reason:</span> {permit.extension.reason || '—'}</p>
                <p><span className="text-ink-500">New valid to:</span> {fmt(permit.extension.newValidTo)}</p>
                {permit.extension.participantChanges && <p><span className="text-ink-500">Participant changes:</span> {permit.extension.participantChanges}</p>}
                {permit.extension.riskChanges && <p><span className="text-ink-500">Risk changes:</span> {permit.extension.riskChanges}</p>}
              </div>
              {permit.extension.suggestions?.length > 0 && (
                <div className="mb-3 space-y-1">
                  <p className="text-xs font-bold uppercase tracking-wide text-ink-500">Suggestions</p>
                  {permit.extension.suggestions.map((s, i) => (
                    <p key={i} className="text-xs text-ink-600">• {s.text} <span className="text-ink-400">— {s.byName}</span></p>
                  ))}
                </div>
              )}
              <div className="space-y-2.5">
                <TeamRow label="Engineering" block={permit.extension.engineering} actionable={engAction}
                  onApprove={() => openDecision('extension', TEAMS.ENGINEERING, 'approved')}
                  onReject={() => openDecision('extension', TEAMS.ENGINEERING, 'rejected')} />
                <TeamRow label="Operations" block={permit.extension.operations} actionable={opsAction}
                  onApprove={() => openDecision('extension', TEAMS.OPERATIONS, 'approved')}
                  onReject={() => openDecision('extension', TEAMS.OPERATIONS, 'rejected')} />
              </div>
              {can(profile, 'addSuggestion') && (
                <button className="btn-ghost mt-3 w-full" onClick={() => { setSuggest({ text: '', newValidTo: toLocalInput(permit.extension.newValidTo) }); setSuggestOpen(true) }}>
                  <MessageSquarePlus size={15} /> Add suggestion / adjust time
                </button>
              )}
            </div>
          )}

          {permit.closure && (
            <div className="card p-5">
              <h2 className="mb-2 flex items-center gap-2 text-base font-bold text-ink-900"><Lock size={18} className="text-brand-600" /> Closure</h2>
              <p className="mb-3 text-xs text-ink-500">Requested by {permit.closure.requestedByName} · {fmt(permit.closure.requestedAt)}</p>
              <div className="space-y-2.5">
                <TeamRow label="Engineering" block={permit.closure.engineering} actionable={engAction}
                  onApprove={() => openDecision('closure', TEAMS.ENGINEERING, 'approved')}
                  onReject={() => openDecision('closure', TEAMS.ENGINEERING, 'rejected')} />
                <TeamRow label="Operations" block={permit.closure.operations} actionable={opsAction}
                  onApprove={() => openDecision('closure', TEAMS.OPERATIONS, 'approved')}
                  onReject={() => openDecision('closure', TEAMS.OPERATIONS, 'rejected')} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Hidden printable */}
      <div style={{ position: 'absolute', left: -10000, top: 0 }} aria-hidden>
        <PermitPrintable ref={printRef} permit={permit} documents={documents} />
      </div>

      {/* Decision modal */}
      <Modal open={!!decision} onClose={() => setDecision(null)} title={decision?.decision === 'approved' ? 'Approve' : 'Reject'}>
        <p className="mb-3 text-sm text-ink-600">
          {decision?.team === TEAMS.ENGINEERING ? 'Engineering' : 'Operations'} decision on{' '}
          {decision?.stage === 'permit' ? 'this permit' : decision?.stage}.
        </p>
        <Field label="Note (optional)"><textarea rows={3} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a comment…" /></Field>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setDecision(null)}>Cancel</button>
          <button className={decision?.decision === 'approved' ? 'btn-primary' : 'btn-danger'} onClick={confirmDecision} disabled={busy}>
            {busy ? <Spinner size={18} /> : decision?.decision === 'approved' ? 'Approve' : 'Reject'}
          </button>
        </div>
      </Modal>

      {/* Request closure modal */}
      {/* Deleting destroys the record of who authorised what work, so it asks
          for the permit number rather than a single OK — the same guard used
          for anything that cannot be undone. */}
      <Modal open={deleting} onClose={() => { setDeleting(false); setConfirmNo('') }} title="Delete this permit?">
        <p className="text-sm text-ink-600">
          This removes permit <strong>{permit.permitNo}</strong>, its attached documents and its QR
          code permanently. The audit log keeps a record that it was deleted, but the permit itself
          cannot be recovered.
        </p>
        <div className="mt-3">
          <Field label={`Type ${permit.permitNo} to confirm`}>
            <input className="input" value={confirmNo} onChange={(e) => setConfirmNo(e.target.value)} placeholder={permit.permitNo} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => { setDeleting(false); setConfirmNo('') }}>Cancel</button>
          <button className="btn-danger" onClick={onDelete} disabled={busy || confirmNo.trim() !== permit.permitNo}>
            {busy ? <Spinner size={18} /> : 'Delete permanently'}
          </button>
        </div>
      </Modal>

      <Modal open={closing} onClose={() => setClosing(false)} title="Request closure">
        <p className="text-sm text-ink-600">Submit this permit for closure. Both Engineering and Operations must approve to close it.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setClosing(false)}>Cancel</button>
          <button className="btn-primary" onClick={submitClosure} disabled={busy}>{busy ? <Spinner size={18} /> : 'Submit for closure'}</button>
        </div>
      </Modal>

      {/* Request extension modal */}
      <Modal open={extOpen} onClose={() => setExtOpen(false)} title="Request extension">
        <div className="space-y-3">
          <Field label="Reason *"><textarea rows={2} className="input" value={extForm.reason} onChange={(e) => setExtForm({ ...extForm, reason: e.target.value })} placeholder="Why is more time needed?" /></Field>
          <Field label="Extend valid-to until"><input type="datetime-local" className="input" value={extForm.newValidTo} onChange={(e) => setExtForm({ ...extForm, newValidTo: e.target.value })} /></Field>
          <Field label="Participant changes"><input className="input" value={extForm.participantChanges} onChange={(e) => setExtForm({ ...extForm, participantChanges: e.target.value })} placeholder="Any change to participants" /></Field>
          <Field label="Risk changes"><input className="input" value={extForm.riskChanges} onChange={(e) => setExtForm({ ...extForm, riskChanges: e.target.value })} placeholder="Any change to risk / hazards" /></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setExtOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={submitExtension} disabled={busy}>{busy ? <Spinner size={18} /> : 'Request extension'}</button>
        </div>
      </Modal>

      {/* Add suggestion modal */}
      <Modal open={suggestOpen} onClose={() => setSuggestOpen(false)} title="Add suggestion">
        <div className="space-y-3">
          <Field label="Suggestion"><textarea rows={2} className="input" value={suggest.text} onChange={(e) => setSuggest({ ...suggest, text: e.target.value })} placeholder="e.g. reduce extension to 4 hours" /></Field>
          <Field label="Adjust proposed end time"><input type="datetime-local" className="input" value={suggest.newValidTo} onChange={(e) => setSuggest({ ...suggest, newValidTo: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setSuggestOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={submitSuggestion} disabled={busy}>{busy ? <Spinner size={18} /> : 'Add suggestion'}</button>
        </div>
      </Modal>

      {/* Log observation modal */}
      <Modal open={obsOpen} onClose={() => setObsOpen(false)} title="Log safety observation">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setObs({ ...obs, type: 'safe' })}
              className={`flex items-center justify-center gap-2 rounded-2xl border-2 p-3 text-sm font-bold transition ${obs.type === 'safe' ? 'border-green-500 bg-green-50 text-green-700' : 'border-transparent bg-surface text-ink-500'}`}>
              <CheckCircle2 size={18} /> Safe
            </button>
            <button type="button" onClick={() => setObs({ ...obs, type: 'unsafe' })}
              className={`flex items-center justify-center gap-2 rounded-2xl border-2 p-3 text-sm font-bold transition ${obs.type === 'unsafe' ? 'border-red-600 bg-red-50 text-red-700' : 'border-transparent bg-surface text-ink-500'}`}>
              <AlertTriangle size={18} /> Unsafe
            </button>
          </div>
          <Field label="Observation note">
            <textarea rows={3} className="input" placeholder="Describe what you observed…" value={obs.note} onChange={(e) => setObs({ ...obs, note: e.target.value })} />
          </Field>
          {obs.type === 'unsafe' && (
            <p className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              <AlertTriangle size={14} /> An unsafe observation will immediately close this permit (Non-Compliance).
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setObsOpen(false)}>Cancel</button>
          <button className={obs.type === 'unsafe' ? 'btn-danger' : 'btn-primary'} onClick={submitObservation} disabled={busy}>
            {busy ? <Spinner size={18} /> : obs.type === 'unsafe' ? 'Log & close permit' : 'Log observation'}
          </button>
        </div>
      </Modal>
    </div>
  )
}

function Detail({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={14} className="text-ink-400" />
      <span className="text-ink-500">{label}:</span>
      <span className="font-semibold text-ink-800">{value || '—'}</span>
    </div>
  )
}
