import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { useAuth } from '../../context/AuthContext'
import { useLocks } from '../../hooks/useLocks'
import { useTechnicians } from '../../hooks/useTechnicians'
import { useOrgProcedures } from '../../hooks/useOrgProcedures'
import { addLock, deleteLock, updateLock } from '../../services/locks'
import { collectInUseLockNos, collectLockUsage } from '../../utils/lockout'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import EmptyState from '../../components/EmptyState'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'
import Badge from '../../components/ui/Badge'

export default function LockInventory() {
  const { profile } = useAuth()
  const { locks, loading } = useLocks()
  const { technicians } = useTechnicians()
  const { procedures } = useOrgProcedures()
  const [form, setForm] = useState({ lockNo: '', type: 'department', tagNo: '', color: 'red' })
  const [saving, setSaving] = useState(false)

  const inUse = useMemo(() => collectInUseLockNos(procedures), [procedures])
  const usage = useMemo(() => collectLockUsage(procedures), [procedures])

  // Every technician's dedicated lock is tracked here too. Show inventory locks
  // plus any technician lock not already present (deduped by lock number).
  const displayLocks = useMemo(() => {
    const seen = new Set(locks.map((l) => (l.lockNo || '').toLowerCase()))
    const derived = technicians
      .filter((t) => t.lockNo && !seen.has(t.lockNo.toLowerCase()))
      .map((t) => ({
        id: `tech-${t.id}`,
        lockNo: t.lockNo,
        type: 'personal',
        active: t.active !== false,
        source: 'technician',
        techName: t.name,
      }))
    return [...locks, ...derived].sort((a, b) =>
      (a.lockNo || '').localeCompare(b.lockNo || '', undefined, { numeric: true }),
    )
  }, [locks, technicians])

  async function onAdd(e) {
    e.preventDefault()
    if (!form.lockNo.trim()) return toast.error('Lock no. is required')
    const wanted = form.lockNo.trim().toLowerCase()
    if (displayLocks.some((l) => (l.lockNo || '').toLowerCase() === wanted)) {
      return toast.error('That lock number already exists (department or technician lock)')
    }
    setSaving(true)
    try {
      await addLock({ lockNo: form.lockNo, type: 'department', tagNo: form.tagNo, color: form.color }, profile)
      setForm({ lockNo: '', type: 'department', tagNo: '', color: 'red' })
      toast.success('Department lock added')
    } catch (err) {
      toastCaught(err, 'Could not add lock')
    } finally {
      setSaving(false)
    }
  }

  async function onDelete(l) {
    if (inUse.has(l.lockNo)) return toast.error('Lock is currently in use')
    if (!window.confirm(`Remove lock "${l.lockNo}"?`)) return
    try {
      await deleteLock(l.id)
      toast.success('Removed')
    } catch (err) {
      toastCaught(err, 'Could not remove')
    }
  }

  async function toggleService(l) {
    const next = l.serviceStatus === 'out_of_service' ? 'available' : 'out_of_service'
    try {
      await updateLock(l.id, {
        serviceStatus: next,
        history: [...(l.history || []), { at: Date.now(), action: next, by: profile.id }],
      })
    } catch (err) {
      toastCaught(err, 'Update failed')
    }
  }

  async function toggleActive(l) {
    try {
      await updateLock(l.id, { active: l.active === false })
    } catch (err) {
      toastCaught(err, 'Update failed')
    }
  }

  const available = displayLocks.filter((l) => l.active !== false && !inUse.has(l.lockNo)).length

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>} />}
        title="Lock Inventory"
        subtitle="Department locks for LOTO. Personal locks come from the Technicians tab."
        actions={
          <span className="rounded-full bg-safe/15 px-3 py-1 text-sm font-bold text-safe">
            {available} available
          </span>
        }
      />

      <Card animate={false} className="mt-6 !p-5">
        <form onSubmit={onAdd} className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Department lock No."
            value={form.lockNo}
            onChange={(e) => setForm((f) => ({ ...f, lockNo: e.target.value }))}
            placeholder="DEPT-07"
            className="font-mono tracking-wide"
          />
          <Input
            label="Tag number"
            value={form.tagNo}
            onChange={(e) => setForm((f) => ({ ...f, tagNo: e.target.value }))}
            placeholder="RED-07"
          />
          <label className="block text-sm text-steel-200">
            Colour
            <select
              className="input mt-1 w-full"
              value={form.color}
              onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            >
              {['red', 'blue', 'green', 'yellow', 'orange', 'purple'].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit" loading={saving}>Add department lock</Button>
          </div>
        </form>
        <p className="mt-2 text-xs text-steel-400">
          Personal locks are added automatically from each technician’s dedicated lock no. in the{' '}
          <Link to="/loto/technicians" className="font-semibold text-amber-600">
            Technicians
          </Link>{' '}
          tab.
        </p>
      </Card>

      <div className="mt-4">
        {loading ? (
          <div className="py-16">
            <Spinner label="Loading locks…" />
          </div>
        ) : displayLocks.length === 0 ? (
          <EmptyState
            title="No locks yet"
            subtitle="Add a department lock above, or add technicians (their personal locks appear here)."
            icon={<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>}
          />
        ) : (
          <Card animate={false} className="overflow-hidden !p-0">
            <ul className="divide-y divide-steel-700/60">
              {displayLocks.map((l) => {
                const used = inUse.has(l.lockNo)
                const where = usage.get(l.lockNo)
                return (
                  <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="rounded-md bg-hazard px-2.5 py-1 font-mono text-xs font-bold text-ink">
                          {l.lockNo}
                        </span>
                        <Badge
                          className={
                            l.type === 'department'
                              ? 'border-steel-600 bg-steel-800 text-steel-200'
                              : 'border-amber-300 bg-amber-100 text-amber-800'
                          }
                        >
                          {l.type === 'department' ? 'Department' : 'Personal'}
                        </Badge>
                        {l.tagNo && (
                          <span className="text-xs text-steel-300">tag {l.tagNo}</span>
                        )}
                        {l.serviceStatus === 'out_of_service' && (
                          <span className="rounded bg-steel-800 px-1.5 py-0.5 text-[10px] font-bold text-steel-300">
                            OUT OF SERVICE
                          </span>
                        )}
                        {l.source === 'technician' && (
                          <span className="truncate text-xs font-medium text-steel-400">
                            👤 {l.techName || 'Technician'}
                          </span>
                        )}
                        {l.active === false && (
                          <span className="rounded bg-steel-800 px-1.5 py-0.5 text-[10px] font-bold text-steel-400">
                            INACTIVE
                          </span>
                        )}
                      </div>
                      {used && where && (
                        <div className="mt-1 truncate text-xs text-steel-400">
                          🔒 {where.equipment}
                          {where.site ? ` · ${where.site}` : ''} ·{' '}
                          <span className="font-semibold text-steel-300">{where.label}</span>
                          {where.techName ? ` · ${where.techName}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {used ? (
                        <Badge className="border-danger/40 bg-danger/15 text-danger">🔒 In use</Badge>
                      ) : (
                        <Badge className="border-safe/40 bg-safe/15 text-safe">Available</Badge>
                      )}
                      {l.source === 'technician' ? (
                        <span className="rounded-lg border border-steel-700 px-2.5 py-1 text-xs font-medium text-steel-400">
                          Managed in Technicians
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleService(l)}
                            className="rounded-lg border border-steel-700 px-2.5 py-1 text-xs font-medium text-steel-300 hover:border-steel-500"
                          >
                            {l.serviceStatus === 'out_of_service' ? 'Return to service' : 'Out of service'}
                          </button>
                          <button
                            onClick={() => toggleActive(l)}
                            className="rounded-lg border border-steel-700 px-2.5 py-1 text-xs font-medium text-steel-300 hover:border-steel-500"
                          >
                            {l.active === false ? 'Activate' : 'Deactivate'}
                          </button>
                          <button
                            onClick={() => onDelete(l)}
                            className="rounded-lg px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  )
}
