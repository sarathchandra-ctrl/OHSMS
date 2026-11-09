import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { MultiSelect, Select, Textarea, Field } from '../../../../shared/ui'
import { subscribeOrgUsers } from '../../../../shared/org/orgData'
import { useAuth } from '../../context/AuthContext'
import { PERMISSIONS } from '../../constants/roles'
import { useOrgProcedures } from '../../hooks/useOrgProcedures'
import { useTechnicians } from '../../hooks/useTechnicians'
import { useLocks } from '../../hooks/useLocks'
import { collectInUseLockNos } from '../../utils/lockout'
import { LIMITS, WORK_TYPES, requiresEquipment } from '../../constants/permits'
import { deviceLabel, energySourceByKey } from '../../constants/energySources'
import {
  approvedProceduresFor,
  buildPermit,
  equipmentOptions,
  lockChoices,
  equipmentLockWarning,
  snapshotProcedure,
  validateDraft,
} from '../../utils/permitModel'
import { formatWindow, openShiftWindow, shiftKey, shiftsForSite, zoneForSite } from '../../utils/shiftWindow'
import { createPermit } from '../../services/permits'
import { subscribeShiftSettings } from '../../services/shiftSettings'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'
import PermitStandard from '../../components/permits/PermitStandard'

const NEW_LOCK = 'new'
const blankVendor = () => ({ name: '', company: '', contact: '', competent: false, certificatePath: '' })

export default function NewPermit() {
  const navigate = useNavigate()
  const { profile, can, platformRole } = useAuth()
  const { procedures, loading } = useOrgProcedures()
  const { technicians } = useTechnicians()
  const { locks } = useLocks()
  const [users, setUsers] = useState([])
  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)

  const [workType, setWorkType] = useState('')
  const [eqKey, setEqKey] = useState('')
  const [procedureId, setProcedureId] = useState('')
  const [reason, setReason] = useState('')
  const [workOrder, setWorkOrder] = useState('')
  const [shift, setShift] = useState('A')
  const [shiftSettings, setShiftSettings] = useState(null)
  const [groupOn, setGroupOn] = useState(false)
  const [groupNo, setGroupNo] = useState('')
  const [groupMethod, setGroupMethod] = useState('box')
  const [memberLocks, setMemberLocks] = useState({})
  const [personnel, setPersonnel] = useState([])
  const [vendors, setVendors] = useState([])
  // pointKey → 'tech:<id>' | 'lock:<id>' | 'new'; and the typed number for 'new'.
  const [picks, setPicks] = useState({})
  const [newNos, setNewNos] = useState({})

  useEffect(() => {
    return subscribeOrgUsers(setUsers)
  }, [])

  useEffect(() => {
    return subscribeShiftSettings(setShiftSettings)
  }, [])

  const needsEquipment = requiresEquipment(workType)
  const equipment = useMemo(() => equipmentOptions(procedures), [procedures])
  const approved = useMemo(() => approvedProceduresFor(procedures, eqKey), [procedures, eqKey])
  const lockWarning = useMemo(() => equipmentLockWarning(procedures, eqKey), [procedures, eqKey])
  const procedure = useMemo(() => approved.find((p) => p.id === procedureId) || null, [approved, procedureId])
  const snapshot = useMemo(() => (procedure && needsEquipment ? snapshotProcedure(procedure) : null), [procedure, needsEquipment])
  const inUse = useMemo(() => collectInUseLockNos(procedures), [procedures])
  const crew = useMemo(
    () =>
      users
        .filter((u) => u.status === 'approved' && u.uid)
        .map((u) => ({ value: u.uid, label: u.name || u.email || u.uid }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [users],
  )

  const siteShifts = useMemo(
    () => shiftsForSite(shiftSettings, snapshot?.siteId),
    [shiftSettings, snapshot?.siteId],
  )
  const zone = zoneForSite(shiftSettings, snapshot?.siteId)
  const chosenShift = siteShifts.find((s) => shiftKey(s) === shift) || siteShifts[0]
  const win = chosenShift ? openShiftWindow(chosenShift, Date.now(), { zoneOffsetMinutes: zone }) : null
  // Start on the shift that is open now. Once the person picks one, leave it,
  // including a shift that is closed — the message under the field says so.
  const pickedShift = useRef(false)
  useEffect(() => {
    if (pickedShift.current) return
    const open = siteShifts.find((s) => openShiftWindow(s, Date.now(), { zoneOffsetMinutes: zone }))
    if (!open) return
    pickedShift.current = true
    if (shiftKey(open) !== shift) setShift(shiftKey(open))
  }, [siteShifts, zone, shift])

  // Lock numbers already spoken for anywhere an operator could collide with one:
  // applied on a machine, in the register, or dedicated to a technician.
  const knownNos = useMemo(() => {
    const all = new Set([...inUse].map((n) => String(n).toLowerCase()))
    for (const l of locks) if (l.lockNo) all.add(String(l.lockNo).toLowerCase())
    for (const t of technicians) if (t.lockNo) all.add(String(t.lockNo).toLowerCase())
    return all
  }, [inUse, locks, technicians])

  const allChoices = useMemo(() => {
    const { personal, department } = lockChoices({ technicians, locks })
    return [...personal, ...department]
  }, [technicians, locks])

  // Resolve each point's pick into a lock plan, and collect the inline ones.
  const plan = useMemo(() => {
    const out = []
    const inline = []
    if (!snapshot) return { locks: out, inline }
    for (const pt of snapshot.isolationPoints) {
      const pick = picks[pt.key] || ''
      if (pick === NEW_LOCK) {
        const no = (newNos[pt.key] || '').trim()
        out.push({ pointKey: pt.key, lockNo: no, lockType: 'department', techId: null, techName: '' })
        if (no) inline.push(no)
        continue
      }
      const chosen = allChoices.find((c) => c.id === pick)
      out.push({
        pointKey: pt.key,
        lockNo: chosen?.lockNo || '',
        lockType: chosen?.lockType || 'personal',
        techId: chosen?.techId || null,
        techName: chosen?.techName || '',
      })
    }
    return { locks: out, inline }
  }, [snapshot, picks, newNos, allChoices])

  const draft = {
    workType,
    reason,
    workOrder,
    shift: shiftKey(chosenShift),
    windowStartMs: win?.startMs,
    windowEndMs: win?.endMs,
    internalPersonnel: personnel.map((uid) => ({ uid, name: crew.find((c) => c.value === uid)?.label || '' })),
    vendorWorkers: vendors,
    locks: plan.locks,
    group: groupOn
      ? {
          method: groupMethod,
          groupNo,
          primaryUid: personnel[0] || '',
          members: personnel.map((uid) => ({
            uid,
            name: crew.find((c) => c.value === uid)?.label || '',
            lockNo: memberLocks[uid] || '',
          })),
        }
      : null,
  }
  const errors = validateDraft(draft, { snapshot, shifts: siteShifts, zoneOffsetMinutes: zone, technicians })
  // An inline number that already exists would register a duplicate padlock.
  const dupNew = plan.inline.find((no) => knownNos.has(no.toLowerCase()))
  if (dupNew) errors.locks = `Lock ${dupNew} already exists — pick it from the list instead.`
  if (new Set(plan.inline.map((n) => n.toLowerCase())).size !== plan.inline.length) {
    errors.locks = 'Each isolation point needs its own lock number.'
  }
  const show = (k) => (tried ? errors[k] : undefined)

  function chooseWorkType(next) {
    setWorkType(next)
    if (!requiresEquipment(next)) {
      setEqKey('')
      setProcedureId('')
      setPicks({})
      setNewNos({})
    }
  }
  function chooseEquipment(key) {
    setEqKey(key)
    setProcedureId('')
    setPicks({})
    setNewNos({})
  }
  function chooseShift(key) {
    pickedShift.current = true
    setShift(key)
  }

  async function onSubmit(e) {
    e.preventDefault()
    setTried(true)
    if (Object.keys(errors).length) return toast.error('Fix the highlighted fields first')
    setSaving(true)
    try {
      const permit = buildPermit({ user: profile, draft, snapshot })
      const no = await createPermit({ user: profile, permit, inlineLocks: plan.inline })
      toast.success(`Permit ${no} requested`)
      navigate(`/loto/permits/${encodeURIComponent(no)}`)
    } catch (err) {
      toastCaught(err, 'Could not raise the permit')
    } finally {
      setSaving(false)
    }
  }

  const setVendor = (i, patch) => setVendors((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  if (platformRole === 'auditor' || !can(PERMISSIONS.PERMIT_REQUEST)) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card animate={false} className="!p-6 text-sm text-steel-200">
          Your role can read permits but not raise them.
        </Card>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><path d="M9 4h6l1 2h3v14H5V6h3l1-2Z" /><path d="M12 10v6M9 13h6" /></>} />}
        title="Raise a permit"
        subtitle="Request permission to isolate equipment for one job and one shift."
      />
      <PermitStandard className="-mt-3 mb-4" />

      {loading ? (
        <div className="py-16">
          <Spinner label="Loading equipment…" />
        </div>
      ) : (
        <div className="space-y-5">
          <Card animate={false} className="space-y-4 !p-5">
            <Field label="Work type" htmlFor="pm-worktype" error={show('workType')}>
              <Select id="pm-worktype" value={workType} onChange={(e) => chooseWorkType(e.target.value)}>
                <option value="">Select…</option>
                {WORK_TYPES.map((w) => (
                  <option key={w.key} value={w.key}>{w.label}</option>
                ))}
              </Select>
            </Field>

            {needsEquipment && (
              <>
                <Field
                  label="Equipment"
                  htmlFor="pm-equipment"
                  hint="Machine maintenance and electrical work must be raised against equipment."
                >
                  <Select id="pm-equipment" value={eqKey} onChange={(e) => chooseEquipment(e.target.value)}>
                    <option value="">Select equipment…</option>
                    {equipment.map((q) => (
                      <option key={q.key} value={q.key} disabled={q.approved === 0}>
                        {q.equipment}{q.site ? ` — ${q.site}` : ''}{q.approved === 0 ? ' (no approved procedure)' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Approved procedure"
                  htmlFor="pm-procedure"
                  hint="Only this equipment's approved procedures are listed."
                  error={show('procedure')}
                >
                  <Select
                    id="pm-procedure"
                    value={procedureId}
                    disabled={!eqKey}
                    onChange={(e) => {
                      setProcedureId(e.target.value)
                      setPicks({})
                      setNewNos({})
                    }}
                  >
                    <option value="">{eqKey ? 'Select a procedure…' : 'Choose the equipment first'}</option>
                    {approved.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.procedureCode || p.id} · rev {p.revision ?? 0}
                      </option>
                    ))}
                  </Select>
                </Field>

                {lockWarning && (
                  <p role="status" className="rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 text-sm text-amber-900">
                    {lockWarning}
                  </p>
                )}

                {snapshot && (
                  <div className="rounded-xl border border-steel-700 bg-steel-900/40 p-4 text-sm" aria-live="polite">
                    <p className="font-semibold text-steel-100">
                      {snapshot.pointCount} isolation point{snapshot.pointCount === 1 ? '' : 's'}
                    </p>
                    <p className="mt-1 text-steel-300">
                      Lock-out devices: {snapshot.devices.length ? snapshot.devices.map(deviceLabel).join(', ') : 'none listed'}
                    </p>
                    <ul className="mt-2 space-y-1 text-xs text-steel-300">
                      {snapshot.isolationPoints.map((pt) => (
                        <li key={pt.key}>
                          <span className="font-mono font-bold">{pt.pointId}</span> · {energySourceByKey(pt.energySource)?.label || pt.energyLabel || pt.energySource}
                          {pt.devices.length ? ` · ${pt.devices.map(deviceLabel).join(', ')}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            <Field
              label="Job description"
              htmlFor="pm-reason"
              error={show('reason')}
              hint={`${reason.length}/${LIMITS.text}`}
            >
              <Textarea
                id="pm-reason"
                rows={3}
                maxLength={LIMITS.text}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Input label="Work order / reference (optional)" value={workOrder} maxLength={200} onChange={(e) => setWorkOrder(e.target.value)} />
          </Card>

          <Card animate={false} className="space-y-4 !p-5">
            <h2 className="font-semibold text-steel-100">Shift window</h2>
            <Field label="Shift" htmlFor="pm-shift" error={show('window')}>
              <Select id="pm-shift" value={shiftKey(chosenShift)} onChange={(e) => chooseShift(e.target.value)}>
                {siteShifts.map((s) => (
                  <option key={shiftKey(s)} value={shiftKey(s)}>{s.label}</option>
                ))}
              </Select>
            </Field>
            {win ? (
              <p className="text-sm text-steel-200">
                {formatWindow(win.startMs)} – {formatWindow(win.endMs)}.
                {win.crossesMidnight ? ' This shift crosses midnight and ends the next day.' : ''}
                {' '}Start and end cannot be typed. A request opens 30 minutes before the shift starts.
              </p>
            ) : (
              <p role="status" className="text-sm text-amber-800">
                This shift is not open. A request can be raised from 30 minutes before it starts until it ends.
              </p>
            )}
            <p className="text-xs text-steel-400">
              Only an Admin can extend a permit past the shift end, and the reason is kept with the permit.
              The permit is due when the window ends and overdue after it, judged on the server clock.
            </p>
          </Card>

          <Card animate={false} className="space-y-4 !p-5">
            <h2 className="font-semibold text-steel-100">People doing the work</h2>
            <Field label="Colleagues (app users)">
              <MultiSelect options={crew} value={personnel} onChange={setPersonnel} empty="No users to choose from" />
            </Field>
            <div>
              <div className="flex items-center justify-between">
                <span className="label !mb-0">Contractors / vendor workers</span>
                <button
                  type="button"
                  onClick={() => setVendors((v) => [...v, blankVendor()])}
                  className="text-xs font-semibold text-amber-600 hover:underline"
                >
                  + Add contractor
                </button>
              </div>
              <p className="mt-1 text-xs text-steel-400">Recorded as text on this permit only — they do not need an account, and they are not emailed.</p>
              {vendors.map((v, i) => (
                <div key={i} className="mt-2 space-y-2 rounded-lg border border-steel-700 p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                    <Input label="Name" value={v.name} maxLength={LIMITS.name} onChange={(e) => setVendor(i, { name: e.target.value })} />
                    <Input label="Company" value={v.company} maxLength={LIMITS.name} onChange={(e) => setVendor(i, { company: e.target.value })} />
                    <Input label="Phone (not email)" value={v.contact} maxLength={LIMITS.name} onChange={(e) => setVendor(i, { contact: e.target.value })} />
                    <button
                      type="button"
                      onClick={() => setVendors((rows) => rows.filter((_, j) => j !== i))}
                      className="rounded-lg px-2.5 py-2 text-xs font-medium text-danger hover:bg-danger/10"
                    >
                      Remove
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-steel-200">
                    <input
                      type="checkbox"
                      checked={v.competent === true}
                      onChange={(e) => setVendor(i, { competent: e.target.checked })}
                    />
                    Competence in this work is confirmed
                  </label>
                    <Input
                      label="Certificate photo (optional)"
                      type="file"
                      accept="image/*"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return setVendor(i, { certificatePath: '' })
                        try {
                          const dataUrl = await new Promise((resolve, reject) => {
                            const reader = new FileReader()
                            reader.onload = () => resolve(reader.result)
                            reader.onerror = () => reject(reader.error)
                            reader.readAsDataURL(file)
                          })
                          const { putFile } = await import('../../../../shared/storage')
                          const up = await putFile('loto-certificates', dataUrl, file.name)
                          setVendor(i, { certificatePath: up?.path || '' })
                        } catch {
                          setVendor(i, { certificatePath: '' })
                        }
                      }}
                    />
                </div>
              ))}
            </div>
            {(show('personnel') || show('vendorWorkers') || show('group')) && (
              <p role="alert" className="text-xs font-medium text-red-400">{errors.personnel || errors.vendorWorkers || errors.group}</p>
            )}
          </Card>

          <Card animate={false} className="space-y-3 !p-5">
            <label className="flex items-center gap-2 text-sm font-semibold text-steel-100">
              <input type="checkbox" checked={groupOn} onChange={(e) => setGroupOn(e.target.checked)} />
              Group lockout
            </label>
            {groupOn && (
              <>
                <p className="text-xs text-steel-400">
                  At least two colleagues, each with their own personal lock. The first person listed is the primary and comes off last. The permit closes when that lock comes off.
                </p>
                <Input id="pm-group-no" label="Group number" value={groupNo} onChange={(e) => setGroupNo(e.target.value)} placeholder="GL-1" />
                <Field label="Method" htmlFor="pm-group-method">
                  <Select id="pm-group-method" value={groupMethod} onChange={(e) => setGroupMethod(e.target.value)}>
                    <option value="box">Group lock box</option>
                    <option value="hasp">Hasp</option>
                  </Select>
                </Field>
                {personnel.map((uid) => (
                  <Input
                    key={uid}
                    label={`Personal lock for ${crew.find((c) => c.value === uid)?.label || uid}`}
                    value={memberLocks[uid] || ''}
                    onChange={(e) => setMemberLocks((m) => ({ ...m, [uid]: e.target.value }))}
                  />
                ))}
              </>
            )}
          </Card>

          {snapshot && (
            <Card animate={false} className="space-y-3 !p-5">
              <h2 className="font-semibold text-steel-100">Locks for each isolation point</h2>
              <p className="text-xs text-steel-400">
                Pick a lock from the register or technicians, or register a new department lock right here.
                {snapshot.pointCount > 1 && ' Several points need a Department lock on each.'}
              </p>
              {snapshot.isolationPoints.map((pt) => {
                const mine = picks[pt.key] || ''
                const taken = plan.locks.filter((l) => l.pointKey !== pt.key).map((l) => l.lockNo)
                const { personal, department } = lockChoices({ technicians, locks, inUse, chosen: taken })
                const options = snapshot.pointCount > 1 ? department : [...department, ...personal]
                return (
                  <div key={pt.key} className="grid gap-2 sm:grid-cols-[120px_1fr_1fr] sm:items-end">
                    <span className="font-mono text-sm font-bold text-steel-100">{pt.pointId}</span>
                    <Field label={`Lock for ${pt.pointId}`} htmlFor={`pm-lock-${pt.key}`}>
                      <Select
                        id={`pm-lock-${pt.key}`}
                        value={mine}
                        onChange={(e) => setPicks((p) => ({ ...p, [pt.key]: e.target.value }))}
                      >
                        <option value="">Select a lock…</option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            #{o.lockNo} · {o.lockType === 'department' ? 'Department' : o.techName || 'Personal'}
                          </option>
                        ))}
                        <option value={NEW_LOCK}>Register a new lock…</option>
                      </Select>
                    </Field>
                    {mine === NEW_LOCK && (
                      <Input
                        label={`New lock no. for ${pt.pointId}`}
                        value={newNos[pt.key] || ''}
                        maxLength={40}
                        onChange={(e) => setNewNos((n) => ({ ...n, [pt.key]: e.target.value }))}
                      />
                    )}
                  </div>
                )
              })}
              {show('locks') && <p role="alert" className="text-xs font-medium text-red-400">{errors.locks}</p>}
            </Card>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="steel" onClick={() => navigate('/loto/permits')}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Request permit
            </Button>
          </div>
        </div>
      )}
    </form>
  )
}
