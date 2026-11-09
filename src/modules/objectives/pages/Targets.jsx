import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Target, Plus, Pencil, Trash2, Wand2, Search } from 'lucide-react'
import { PageHeader, Card, Field, Input, Select, Textarea, Button, Modal, Badge, EmptyState, SkeletonTable, Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useObjectives } from '../context/ObjectivesContext'
import DocIdTag from '../../../shared/docId/DocIdTag'
import { addObjective, updateObjective, deleteObjective, seedDefaultTargets } from '../lib/firestore'
import { KPIS, KPI_BY_KEY, LEVELS } from '../lib/kpis'

const thisPeriod = () => `FY${new Date().getFullYear()}`

const EMPTY = { kpi: 'auditPass', level: 'org', scope: '', entity: 'all', target: '', period: thisPeriod(), owner: '', notes: '' }

export default function Targets() {
  const { actor, isManager } = useAuth()
  const { loading, objectives, regionScopes, siteScopes, entities } = useObjectives()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')

  const kpi = KPI_BY_KEY[form.kpi]
  const levelOptions = LEVELS.filter((l) => kpi?.levels.includes(l.key))
  const scopeOptions = form.level === 'region' ? regionScopes : form.level === 'site' ? siteScopes : []

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return objectives
      .map((o) => ({ ...o, kpiMeta: KPI_BY_KEY[o.kpi] }))
      .filter((o) => (needle ? `${o.kpiMeta?.label} ${o.scopeLabel} ${o.entity} ${o.owner}`.toLowerCase().includes(needle) : true))
      .sort((a, b) => (a.kpiMeta?.label || '').localeCompare(b.kpiMeta?.label || '') || a.level.localeCompare(b.level))
  }, [objectives, q])

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(rows)

  const openNew = () => { setForm({ ...EMPTY, period: thisPeriod() }); setEditing('new') }
  const openEdit = (o) => { setForm({ ...EMPTY, ...o, target: String(o.target ?? '') }); setEditing(o) }

  const save = async (e) => {
    e.preventDefault()
    if (form.target === '' || Number.isNaN(Number(form.target))) return toast.error('Enter a numeric target')
    if (form.level !== 'org' && !form.scope) return toast.error(`Pick a ${form.level}`)
    setBusy(true)
    try {
      const scopeLabel = form.level === 'org'
        ? 'Organization'
        : scopeOptions.find((s) => s.value === form.scope)?.label || form.scope
      const payload = { ...form, scopeLabel }
      if (editing === 'new') { await addObjective(payload, actor); toast.success('Target set') }
      else { await updateObjective(editing.id, payload, actor); toast.success('Target updated') }
      setEditing(null)
    } catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  const remove = async (o) => {
    if (!window.confirm(`Remove the ${o.kpiMeta?.label} target for ${o.scopeLabel || 'Organization'}?`)) return
    try { await deleteObjective(o.id, actor, `${o.kpiMeta?.label} · ${o.scopeLabel}`); toast.success('Target removed') }
    catch (err) { toastCaught(err, 'Failed') }
  }

  const seed = async () => {
    if (!window.confirm(`Create one organization-level target per KPI at its recommended default (${KPIS.length} targets)?`)) return
    setBusy(true)
    try {
      const n = await seedDefaultTargets(thisPeriod(), actor)
      toast.success(`${n} default targets created`)
    } catch (err) { toastCaught(err, 'Failed') } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader
        title="Targets"
        subtitle="Set the target for each KPI at organization, region or site level"
        icon={Target}
        actions={isManager && (
          <div className="flex flex-wrap gap-2">
            {objectives.length === 0 && (
              <Button variant="soft" icon={Wand2} loading={busy} onClick={seed}>Use recommended defaults</Button>
            )}
            <Button icon={Plus} onClick={openNew}>Set target</Button>
          </div>
        )}
      />

      <Card className="mb-4">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search KPI, scope or owner…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </Card>

      {loading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Target}
          title={objectives.length ? 'No matching targets' : 'No targets set yet'}
          description={objectives.length
            ? 'Try a different search.'
            : 'Set a target per KPI — the scorecard measures actuals live from each module and rates them against these.'}
          action={isManager && objectives.length === 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="soft" icon={Wand2} onClick={seed}>Use recommended defaults</Button>
              <Button icon={Plus} onClick={openNew}>Set target</Button>
            </div>
          )}
        />
      ) : (
        <Card className="overflow-hidden !p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-5 py-3">KPI</th>
                  <th className="px-4 py-3">Level</th>
                  <th className="px-4 py-3">Scope</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3 text-center">Target</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Owner</th>
                  {isManager && <th className="px-4 py-3"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((o) => (
                  <tr key={o.id} className="hover:bg-surface-100/50">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-ink-900">{o.kpiMeta?.label || o.kpi}</p>
                      <p className="text-xs text-ink-400">{o.kpiMeta?.source}</p>
                      <DocIdTag id={o.docId} />
                    </td>
                    <td className="px-4 py-3"><Badge tone="brand">{LEVELS.find((l) => l.key === o.level)?.label || o.level}</Badge></td>
                    <td className="px-4 py-3 text-ink-700">{o.scopeLabel || 'Organization'}</td>
                    <td className="px-4 py-3 text-ink-600">{o.entity === 'all' ? 'All' : o.entity}</td>
                    <td className="px-4 py-3 text-center font-bold text-ink-900">
                      {o.kpiMeta?.higherIsBetter ? '≥ ' : '≤ '}{o.target}{o.kpiMeta?.unit}
                    </td>
                    <td className="px-4 py-3 text-ink-600">{o.period || '—'}</td>
                    <td className="px-4 py-3 text-ink-600">{o.owner || '—'}</td>
                    {isManager && (
                      <td className="px-4 py-3 text-right">
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => openEdit(o)} title="Edit"><Pencil size={13} /></button>
                        <button className="btn-ghost px-2 py-1 text-xs text-red-600 hover:bg-red-50" onClick={() => remove(o)} title="Remove"><Trash2 size={13} /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-ink-100 px-3 py-2"
            page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize}
          />
        </Card>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Set target' : 'Edit target'} size="lg">
        <form onSubmit={save} className="space-y-4 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="KPI *">
              <Select value={form.kpi} onChange={(e) => {
                const k = KPI_BY_KEY[e.target.value]
                setForm((f) => ({
                  ...f, kpi: e.target.value,
                  level: k.levels.includes(f.level) ? f.level : k.levels[0],
                  scope: '', target: f.target || String(k.defaultTarget),
                }))
              }}>
                {KPIS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </Select>
            </Field>
            <Field label={`Target ${kpi?.unit === '%' ? '(%)' : '(count)'} *`}
              hint={kpi?.higherIsBetter ? 'Actuals at or above this are on target' : 'Actuals at or below this are on target'}>
              <Input type="number" step="any" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
            </Field>
          </div>

          <p className="ring-1 ring-ink-200 rounded-xl bg-surface-50 px-3.5 py-2.5 text-xs text-ink-600 ">{kpi?.help}</p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Level *">
              <Select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value, scope: '' })}>
                {levelOptions.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </Select>
            </Field>
            {form.level !== 'org' && (
              <Field label={form.level === 'region' ? 'Region *' : 'Site *'}>
                <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
                  <option value="">Select…</option>
                  {scopeOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              </Field>
            )}
            {kpi?.byEntity && form.level !== 'site' && (
              <Field label="Entity" hint="Set a separate target per entity, or leave as All">
                <Select value={form.entity} onChange={(e) => setForm({ ...form, entity: e.target.value })}>
                  <option value="all">All entities</option>
                  {entities.map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Period">
              <Input value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} placeholder="e.g. FY2026" />
            </Field>
            <Field label="Owner">
              <Input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="Accountable person" />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" loading={busy}>{editing === 'new' ? 'Set target' : 'Save changes'}</Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
