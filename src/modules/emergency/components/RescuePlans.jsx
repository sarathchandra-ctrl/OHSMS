import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  LifeBuoy, Plus, Pencil, Trash2, X, Users, Wrench, ChevronDown, ChevronUp, Library, Check,
  BadgeCheck, ShieldAlert, RefreshCw,
} from 'lucide-react'
import { Card, Field, Input, Select, Textarea, Button, Modal, Badge, EmptyState } from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import DeptPersonPicker from '../../../shared/org/DeptPersonPicker'
import { formatDate } from '../../../shared/lib/format'
import { erpRoleLabel, renderRoleTokens, ERP_ROLES, ALL_EMPLOYEES } from '../../../shared/org/erpRoles'
import { useErpRoleLabels } from '../../../shared/org/useErpRoleLabels'
import {
  addRescuePlan, updateRescuePlan, deleteRescuePlan, recallBaselines, approveRescuePlan,
  RESCUE_SCENARIOS, PLAN_STATUS, syncFromBaseline, isBehindBaseline, baselineFor,
} from '../lib/firestore'

const newStep = () => ({ id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action: '', responsible: '' })
const newMember = () => ({ id: `tm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, role: '', name: '', phone: '', uid: '' })

const EMPTY = {
  scenario: 'Fire / Explosion', title: '', description: '', triggers: '', assemblyPoint: '',
  steps: [newStep()], team: [newMember()], equipment: [], status: 'draft', reviewedOn: '', nextReviewOn: '',
}

const statusMeta = (key) => PLAN_STATUS.find((s) => s.key === key) || PLAN_STATUS[0]

/**
 * Rescue plans list + editor. Runs in two modes:
 *  • site mode (default)  — a site's own plans, recallable from the baseline library
 *  • baseline mode        — the org-wide template library (`baseline` prop)
 */
export default function RescuePlans({ site, plans, users, contacts = [], baseline = false }) {
  const roleLabels = useErpRoleLabels()
  const { actor, isManager } = useAuth()
  const [editing, setEditing] = useState(null) // 'new' | plan | null
  const [form, setForm] = useState(EMPTY)
  const [equipInput, setEquipInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(null) // expanded plan id
  const [recallOpen, setRecallOpen] = useState(false)
  const [recallPicked, setRecallPicked] = useState([])
  const [syncing, setSyncing] = useState(null) // site plan whose baseline moved on

  const sitePlans = useMemo(
    () =>
      plans
        .filter((p) => (baseline ? p.kind === 'baseline' : p.kind !== 'baseline' && p.siteId === site?.id))
        .sort((a, b) => a.scenario.localeCompare(b.scenario)),
    [plans, site, baseline]
  )

  // Baseline library available to recall (site mode only), minus scenarios the
  // site already covers.
  const baselineLibrary = useMemo(() => plans.filter((p) => p.kind === 'baseline'), [plans])
  const covered = useMemo(() => new Set(sitePlans.map((p) => p.scenario)), [sitePlans])
  const recallable = useMemo(() => baselineLibrary.filter((b) => !covered.has(b.scenario)), [baselineLibrary, covered])
  const missing = RESCUE_SCENARIOS.filter((s) => s !== 'Other' && !covered.has(s))
  const approvedCount = useMemo(() => sitePlans.filter((p) => p.status === 'approved').length, [sitePlans])
  const pendingCount = sitePlans.length - approvedCount

  // Site plans are copies of baselines, so a revised baseline leaves them
  // stale. Surface that — an out-of-date procedure on a wall is worse than a
  // missing one, because people trust it.
  const behind = useMemo(
    () => (baseline ? [] : sitePlans.filter((p) => isBehindBaseline(p, baselineLibrary))),
    [baseline, sitePlans, baselineLibrary]
  )

  const doSync = async (plan, keepLocalEdits) => {
    const b = baselineFor(plan, baselineLibrary)
    if (!b) return toast.error('That baseline no longer exists')
    setBusy(true)
    try {
      await syncFromBaseline(plan, b, actor, { keepLocalEdits })
      toast.success('Updated from baseline — review and approve before use')
      setSyncing(null)
    } catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  const syncAll = async () => {
    // The prompt counts what will ACTUALLY be updated.
    //
    // It used to say behind.length and then process
    // behind.filter(x => !x.customized), so an estate where most plans had been
    // adapted locally was asked to confirm eleven and given three, with nothing
    // on screen to explain the gap. A confirmation that overstates what it is
    // about to do is worse than none: that number is what the decision is
    // weighed on.
    const targets = behind.filter((x) => !x.customized)
    const skipped = behind.length - targets.length
    if (!targets.length) {
      return toast.error('Every plan behind the baseline was adapted locally — update those individually.')
    }
    if (!window.confirm(
      `Update ${targets.length} plan(s) at ${site.name} from the revised baseline?\n\n` +
      'Each returns to draft and must be approved again before use.' +
      (skipped ? `\n\n${skipped} plan(s) you adapted locally are skipped — update those individually so you can choose what to keep.` : '')
    )) return
    setBusy(true)
    let n = 0
    try {
      for (const p of targets) {
        const b = baselineFor(p, baselineLibrary)
        if (b) { await syncFromBaseline(p, b, actor, { keepLocalEdits: false }); n += 1 }
      }
      toast.success(`${n} plan(s) updated — each needs re-approval`)
    } catch (err) {
      // NAME what got through. syncFromBaseline returns each plan to draft, so a
      // throw part-way leaves the earlier ones unprintable — and a bare "Failed"
      // reads as "nothing happened", which is the one thing that is not true.
      toast.error(
        n > 0
          ? `${n} of ${targets.length} plan(s) were updated and are now in draft; the rest were not. ${err?.message || ''}`.trim()
          : (err?.message || 'Failed'),
        { duration: 9000 },
      )
    } finally { setBusy(false) }
  }

  const openNew = (scenario) => {
    setForm({ ...EMPTY, scenario: scenario || EMPTY.scenario, steps: [newStep()], team: [newMember()] })
    setEquipInput('')
    setEditing('new')
  }
  const openEdit = (p) => {
    setForm({
      ...EMPTY, ...p,
      steps: p.steps?.length ? p.steps : [newStep()],
      team: p.team?.length ? p.team : [newMember()],
      equipment: p.equipment || [],
    })
    setEquipInput('')
    setEditing(p)
  }

  const setStep = (id, patch) => setForm((f) => ({ ...f, steps: f.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }))
  const moveStep = (i, dir) => setForm((f) => {
    const next = [...f.steps]
    const j = i + dir
    if (j < 0 || j >= next.length) return f
    ;[next[i], next[j]] = [next[j], next[i]]
    return { ...f, steps: next }
  })
  const setMember = (id, patch) => setForm((f) => ({ ...f, team: f.team.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))

  const addEquip = () => {
    const v = equipInput.trim()
    if (!v) return
    if (!form.equipment.includes(v)) setForm((f) => ({ ...f, equipment: [...f.equipment, v] }))
    setEquipInput('')
  }

  const save = async (e) => {
    e.preventDefault()
    if (!form.title.trim()) return toast.error('Give the plan a title')
    if (!form.steps.some((s) => s.action.trim())) return toast.error('Add at least one response step')
    setBusy(true)
    try {
      const scope = baseline
        ? { kind: 'baseline', siteId: '', siteName: '', region: '', entity: '' }
        : { kind: 'site', siteId: site.id, siteName: site.name, region: site.region || '', entity: site.entity || '' }
      // Editing a recalled plan marks it as adapted for this site. Editing an
      // approved site plan sends it back for re-approval — it's a controlled document.
      const wasApproved = !baseline && editing !== 'new' && editing?.status === 'approved'
      const payload = {
        ...form, ...scope,
        customized: form.customized || (!baseline && !!form.baselineId && editing !== 'new'),
        ...(wasApproved ? { status: 'draft', approvedBy: '', approvedByName: '', approvedOn: '' } : null),
      }
      if (editing === 'new') { await addRescuePlan(payload, actor); toast.success(baseline ? 'Baseline plan created' : 'Rescue plan created') }
      else {
        await updateRescuePlan(editing.id, payload, actor)
        toast.success(wasApproved ? 'Updated — needs re-approval before use' : 'Rescue plan updated')
      }
      setEditing(null)
    } catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  const approve = async (p) => {
    if (!window.confirm(`Approve "${p.title}" for use at ${site.name}?\n\nIt becomes the site's live procedure for ${p.scenario} and prints on the site FERP.`)) return
    setBusy(true)
    try { await approveRescuePlan(p, actor); toast.success('Approved for site use') }
    catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  const doRecall = async () => {
    const picked = recallable.filter((b) => recallPicked.includes(b.id))
    if (!picked.length) return toast.error('Pick at least one baseline plan')
    setBusy(true)
    try {
      const res = await recallBaselines(site, picked, plans, actor, contacts)
      toast.success(`${res.copied} plan(s) recalled to ${site.name}${res.skipped ? ` (${res.skipped} already covered)` : ''}`)
      setRecallOpen(false)
      setRecallPicked([])
    } catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  const remove = async (p) => {
    if (!window.confirm(`Delete the "${p.title}" rescue plan?`)) return
    try { await deleteRescuePlan(p.id, actor, `${site.name} · ${p.title}`); toast.success('Plan deleted') }
    catch (err) { toastCaught(err, 'Failed') }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-ink-800">
          <LifeBuoy size={17} className="text-accent-teal" />
          {baseline
            ? `Baseline rescue plans (${sitePlans.length})`
            : <>Emergency rescue plans — <span className="text-green-700">{approvedCount} in use</span>
                {pendingCount > 0 && <span className="text-amber-600">, {pendingCount} awaiting approval</span>}</>}
        </h3>
        {isManager && (
          <div className="flex flex-wrap gap-2">
            {baseline ? (
              <Button icon={Plus} onClick={() => openNew()}>Add baseline plan</Button>
            ) : (
              <>
                {behind.length > 0 && (
                  <Button variant="soft" icon={RefreshCw} className="!bg-amber-100 !text-amber-900" onClick={syncAll}>
                    Update {behind.length} from baseline
                  </Button>
                )}
                <Button variant="soft" icon={Library} disabled={recallable.length === 0}
                  title={recallable.length ? 'Recall plans from the baseline library' : 'Every baseline scenario is already recalled here'}
                  onClick={() => { setRecallPicked(recallable.map((b) => b.id)); setRecallOpen(true) }}>
                  Recall baseline ({recallable.length})
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {sitePlans.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title={baseline ? 'No baseline plans yet' : 'No rescue plans recalled yet'}
          description={baseline
            ? 'Build your organization’s standard rescue plans here — every site can recall them and adapt locally.'
            : 'Site procedures start from the baseline library: recall a plan, adapt it to this site, then approve it for use.'}
          action={isManager && (
            baseline
              ? <Button icon={Plus} onClick={() => openNew()}>Add baseline plan</Button>
              : recallable.length > 0
                ? <Button variant="soft" icon={Library} onClick={() => { setRecallPicked(recallable.map((b) => b.id)); setRecallOpen(true) }}>
                    Recall baseline ({recallable.length})
                  </Button>
                : <Link to="/emergency-response/baseline" className="btn-primary"><Library size={16} /> Build the baseline library</Link>
          )}
        />
      ) : (
        <div className="space-y-2.5">
          {sitePlans.map((p) => {
            const meta = statusMeta(p.status)
            const isOpen = open === p.id
            return (
              <div key={p.id} className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3.5 ">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="brand">{p.scenario}</Badge>
                      <p className="font-bold text-ink-900">{p.title}</p>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {p.baselineId && (
                        <Badge tone={p.customized ? 'amber' : 'gray'}>
                          <Library size={11} className="mr-1 inline" />
                          {p.customized ? 'Adapted from baseline' : 'From baseline'}
                        </Badge>
                      )}
                      {!baseline && isBehindBaseline(p, baselineLibrary) && (
                        <button
                          className="inline-flex items-center gap-1 rounded-lg bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-200"
                          title="The baseline procedure has been revised since this copy was taken"
                          onClick={(e) => { e.stopPropagation(); setSyncing(p) }}
                        >
                          <RefreshCw size={11} /> Baseline revised
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-400">
                      {p.steps?.length || 0} step(s) · {p.team?.length || 0} responder(s)
                      {p.assemblyPoint ? ` · assembly: ${p.assemblyPoint}` : ''}
                      {p.nextReviewOn ? ` · review by ${formatDate(p.nextReviewOn)}` : ''}
                      {p.status === 'approved' && p.approvedByName ? ` · approved by ${p.approvedByName}${p.approvedOn ? ` on ${formatDate(p.approvedOn)}` : ''}` : ''}
                    </p>
                  </div>
                  {isManager && (
                    <div className="flex items-center gap-1">
                      {!baseline && p.status !== 'approved' && (
                        <Button variant="soft" icon={BadgeCheck} className="!py-1.5 text-xs" loading={busy}
                          onClick={() => approve(p)} title="Approve this plan for use at this site">
                          Approve
                        </Button>
                      )}
                      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => openEdit(p)} title={p.status === 'approved' ? 'Edit (will need re-approval)' : 'Edit'}><Pencil size={13} /></button>
                      <button className="btn-ghost px-2 py-1 text-xs text-red-600 hover:bg-red-50" onClick={() => remove(p)} title="Delete"><Trash2 size={13} /></button>
                    </div>
                  )}
                  <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setOpen(isOpen ? null : p.id)}>
                    {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {isOpen ? 'Hide' : 'Steps'}
                  </button>
                </div>

                {isOpen && (
                  <div className="mt-3 space-y-3 border-t border-surface-200/60 pt-3">
                    {p.description && <p className="text-sm text-ink-700">{p.description}</p>}
                    {p.triggers && <p className="text-xs text-ink-500"><b>Activate when:</b> {p.triggers}</p>}
                    <ol className="space-y-1.5">
                      {(p.steps || []).map((s) => (
                        <li key={s.id} className="flex gap-2.5 text-sm">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-brand-600 text-xs font-bold text-white">{s.order}</span>
                          <span className="text-ink-800">
                            {renderRoleTokens(s.action, roleLabels)}
                            {s.responsible && (
                              <span className="ml-1.5 text-xs font-semibold text-brand-600">
                                — {erpRoleLabel(s.responsible, roleLabels)}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {(p.team || []).length > 0 && (
                      <div>
                        <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-ink-400"><Users size={12} /> Rescue team</p>
                        <div className="flex flex-wrap gap-1.5">
                          {p.team.map((t) => (
                            <span key={t.id} className="chip bg-surface-100 text-ink-700">
                              {t.role ? `${erpRoleLabel(t.role, roleLabels)}: ` : ''}{t.name}{t.phone ? ` · ${t.phone}` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {(p.equipment || []).length > 0 && (
                      <div>
                        <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-ink-400"><Wrench size={12} /> Equipment</p>
                        <div className="flex flex-wrap gap-1.5">
                          {p.equipment.map((eq) => <span key={eq} className="chip bg-accent-amber/15 text-ink-700">{eq}</span>)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Scenario coverage: baselines are authored centrally, so at site level
          we surface the gap and route to the library rather than ad-hoc creation. */}
      {isManager && missing.length > 0 && (
        <div className="mt-4 border-t border-surface-200/60 pt-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-ink-400">
            <ShieldAlert size={12} /> Scenarios without a plan
          </p>
          <div className="flex flex-wrap gap-1.5">
            {missing.map((s) => (
              baseline ? (
                <button key={s} className="chip bg-surface-100 text-ink-500 transition hover:bg-brand-50 hover:text-brand-700" onClick={() => openNew(s)}>
                  <Plus size={11} /> {s}
                </button>
              ) : (
                <span key={s} className="chip bg-surface-100 text-ink-400">{s}</span>
              )
            ))}
          </div>
          {!baseline && (
            <p className="mt-2 text-xs text-ink-400">
              Site procedures come from the baseline library — add the missing scenarios in{' '}
              <Link to="/emergency-response/baseline" className="font-semibold text-brand-600 hover:underline">Baseline Plans</Link>, then recall them here.
            </p>
          )}
        </div>
      )}

      {/* ── Recall from the baseline library ── */}
      <Modal open={recallOpen} onClose={() => setRecallOpen(false)} title={`Recall baseline plans — ${site?.name || ''}`} size="lg">
        <div className="space-y-4 p-6">
          <p className="-mt-1 text-sm text-ink-500">
            Copies your organization&apos;s baseline plans onto this site. Each copy is fully editable —
            adapt the steps, team and equipment locally without affecting the baseline.
          </p>
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {recallable.map((b) => {
              const sel = recallPicked.includes(b.id)
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setRecallPicked((p) => (sel ? p.filter((x) => x !== b.id) : [...p, b.id]))}
                  className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition ${
                    sel ? 'bg-brand-50 shadow-elev-sm' : 'bg-surface-50 '
                  }`}
                >
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md ${sel ? 'bg-brand-600 text-white' : 'bg-surface-200'}`}>
                    {sel && <Check size={13} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink-900">{b.title}</span>
                    <span className="block truncate text-xs text-ink-400">
                      {b.scenario} · {b.steps?.length || 0} step(s) · {b.team?.length || 0} responder(s)
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRecallOpen(false)}>Cancel</Button>
            <Button type="button" icon={Library} loading={busy} onClick={doRecall}>
              Recall {recallPicked.length || '…'} plan{recallPicked.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Plan editor ── */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new'
          ? (baseline ? 'New baseline rescue plan' : `New rescue plan — ${site?.name || ''}`)
          : (baseline ? 'Edit baseline plan' : 'Edit rescue plan')}
        size="xl"
      >
        <form onSubmit={save} className="space-y-4 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scenario *">
              <Select value={form.scenario} onChange={(e) => setForm({ ...form, scenario: e.target.value })}>
                {RESCUE_SCENARIOS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Plan title *">
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Gym floor fire evacuation & rescue" />
            </Field>
          </div>

          <Field label="Description">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this plan covers…" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Activate when (triggers)">
              <Input value={form.triggers} onChange={(e) => setForm({ ...form, triggers: e.target.value })} placeholder="e.g. Fire alarm sounds / smoke detected" />
            </Field>
            <Field label="Assembly point">
              <Input value={form.assemblyPoint} onChange={(e) => setForm({ ...form, assemblyPoint: e.target.value })} placeholder="e.g. Car park — north gate" />
            </Field>
          </div>

          {/* Response steps */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="label !mb-0">Response steps *</span>
              <Button type="button" variant="soft" icon={Plus} className="!py-1.5 text-xs" onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, newStep()] }))}>
                Add step
              </Button>
            </div>
            <div className="space-y-2">
              {form.steps.map((s, i) => (
                <div key={s.id} className="ring-1 ring-ink-200 flex items-start gap-2 rounded-xl bg-surface-50 p-2 ">
                  <div className="flex flex-col items-center gap-0.5 pt-1.5">
                    <span className="grid h-6 w-6 place-items-center rounded-lg bg-brand-600 text-xs font-bold text-white">{i + 1}</span>
                    <button type="button" className="text-ink-300 hover:text-ink-600" onClick={() => moveStep(i, -1)} title="Move up"><ChevronUp size={12} /></button>
                    <button type="button" className="text-ink-300 hover:text-ink-600" onClick={() => moveStep(i, 1)} title="Move down"><ChevronDown size={12} /></button>
                  </div>
                  <div className="grid flex-1 gap-2 sm:grid-cols-[2fr,1fr]">
                    <Input value={s.action} onChange={(e) => setStep(s.id, { action: e.target.value })} placeholder={`Step ${i + 1} — what happens`} />
                    {/* Roles are picked, not typed, so a step always resolves to
                        a real contact when the plan is recalled to a site. */}
                    <Select value={s.responsible} onChange={(e) => setStep(s.id, { responsible: e.target.value })}>
                      <option value="">Responsible role…</option>
                      {ERP_ROLES.filter((r) => r.key !== 'Other').map((r) => (
                        <option key={r.key} value={r.key}>{erpRoleLabel(r.key, roleLabels)}</option>
                      ))}
                      <option value={ALL_EMPLOYEES}>{ALL_EMPLOYEES}</option>
                      {s.responsible && ![...ERP_ROLES.map((r) => r.key), ALL_EMPLOYEES].includes(s.responsible) && (
                        <option value={s.responsible}>{s.responsible}</option>
                      )}
                    </Select>
                  </div>
                  {form.steps.length > 1 && (
                    <button type="button" className="mt-1.5 rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600"
                      onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((x) => x.id !== s.id) }))}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Rescue team */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="label !mb-0">Rescue team</span>
              <Button type="button" variant="soft" icon={Plus} className="!py-1.5 text-xs" onClick={() => setForm((f) => ({ ...f, team: [...f.team, newMember()] }))}>
                Add responder
              </Button>
            </div>
            <div className="space-y-2">
              {form.team.map((t) => (
                <div key={t.id} className="ring-1 ring-ink-200 rounded-xl bg-surface-50 p-2.5 ">
                  <div className="mb-2 grid gap-2 sm:grid-cols-[1fr,1fr]">
                    <Input value={t.role} onChange={(e) => setMember(t.id, { role: e.target.value })} placeholder="Role — e.g. Fire Marshal / First Aider" />
                    <Input value={t.phone} onChange={(e) => setMember(t.id, { phone: e.target.value })} placeholder="Phone" />
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <DeptPersonPicker
                        users={users}
                        value={t.uid}
                        onChange={(v, u) => setMember(t.id, { uid: v, name: u?.name || t.name, phone: t.phone || u?.phone || '' })}
                        personPlaceholder="Select responder…"
                      />
                    </div>
                    {form.team.length > 1 && (
                      <button type="button" className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600"
                        onClick={() => setForm((f) => ({ ...f, team: f.team.filter((x) => x.id !== t.id) }))}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Equipment */}
          <div>
            <span className="label">Rescue equipment</span>
            {form.equipment.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {form.equipment.map((eq) => (
                  <span key={eq} className="chip bg-surface-100 text-ink-700">
                    {eq}
                    <button type="button" onClick={() => setForm((f) => ({ ...f, equipment: f.equipment.filter((x) => x !== eq) }))} className="text-ink-400 hover:text-red-600">
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input value={equipInput} onChange={(e) => setEquipInput(e.target.value)} placeholder="e.g. Stretcher, AED, SCBA set, rescue tripod"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEquip() } }} />
              <Button type="button" variant="soft" icon={Plus} onClick={addEquip}>Add</Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Status">
              <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {PLAN_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </Field>
            <Field label="Reviewed on">
              <Input type="date" value={form.reviewedOn} onChange={(e) => setForm({ ...form, reviewedOn: e.target.value })} />
            </Field>
            <Field label="Next review">
              <Input type="date" value={form.nextReviewOn} onChange={(e) => setForm({ ...form, nextReviewOn: e.target.value })} />
            </Field>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" loading={busy}>{editing === 'new' ? 'Create plan' : 'Save changes'}</Button>
          </div>
        </form>
      </Modal>

      {/* Baseline revised — pull it down, deciding what happens to local wording */}
      <Modal
        open={!!syncing}
        onClose={() => setSyncing(null)}
        title="Baseline procedure has been revised"
        size="lg"
      >
        {syncing && (
          <div className="space-y-4">
            <p className="text-sm text-ink-600">
              <b>{syncing.title}</b> was copied from the baseline library, and the baseline has changed since.
              This site is still following the older version.
            </p>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Updating returns the plan to <b>draft</b>. A changed procedure is a changed controlled document —
              it must be approved again before it is used or printed on the site FERP.
            </div>

            {syncing.customized ? (
              <>
                <p className="text-sm text-ink-600">
                  This copy was <b>adapted for {site?.name}</b>, so choose what to keep:
                </p>
                <div className="flex flex-col gap-2">
                  <Button variant="soft" loading={busy} onClick={() => doSync(syncing, true)}>
                    Take the new steps, keep our wording
                  </Button>
                  <Button variant="ghost" loading={busy} onClick={() => doSync(syncing, false)}>
                    Replace entirely with the baseline — discards local changes
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-ink-600">
                This copy has not been adapted locally, so nothing of yours is lost. The site&apos;s assembly
                point and responder team are kept.
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setSyncing(null)}>Cancel</Button>
              {!syncing.customized && (
                <Button icon={RefreshCw} loading={busy} onClick={() => doSync(syncing, false)}>
                  Update from baseline
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}
