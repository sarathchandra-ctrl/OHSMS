import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { useAuth } from '../../context/AuthContext'
import { useAuth as useAppAuth } from '../../../../shared/auth/AuthContext'
import { useTechnicians } from '../../hooks/useTechnicians'
import { useLocks } from '../../hooks/useLocks'
import { useOrgProcedures } from '../../hooks/useOrgProcedures'
import { collectInUseLockNos } from '../../utils/lockout'
import {
  addTechnician,
  deleteTechnician,
  updateTechnician,
} from '../../services/technicians'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import EmptyState from '../../components/EmptyState'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'

export default function Technicians() {
  const { profile } = useAuth()
  // The register decides who may apply locks, so the
  // server leaves it to managers (stack/policy.mjs); everyone else reads it.
  const { isManager } = useAppAuth()
  const { technicians, loading } = useTechnicians()
  const { locks } = useLocks()
  const { procedures } = useOrgProcedures()
  const [form, setForm] = useState({ name: '', lockNo: '', contact: '', licenceNo: '', licenceExp: '' })
  const [saving, setSaving] = useState(false)

  const inUse = useMemo(() => collectInUseLockNos(procedures), [procedures])

  async function onAdd(e) {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Name is required')
    if (!form.lockNo.trim()) return toast.error('Dedicated lock no. is required')
    const wanted = form.lockNo.trim().toLowerCase()
    if (technicians.some((t) => (t.lockNo || '').toLowerCase() === wanted)) {
      return toast.error('That lock number is already assigned')
    }
    if (locks.some((l) => (l.lockNo || '').toLowerCase() === wanted)) {
      return toast.error('That lock number already exists in the Lock Inventory')
    }
    setSaving(true)
    try {
      await addTechnician({ ...form }, profile)
      setForm({ name: '', lockNo: '', contact: '', licenceNo: '', licenceExp: '' })
      toast.success('Technician added')
    } catch (err) {
      toastCaught(err, 'Could not add technician')
    } finally {
      setSaving(false)
    }
  }

  async function onDelete(t) {
    if (t.lockNo && inUse.has(t.lockNo)) {
      return toast.error("This technician's lock is currently applied — remove it first")
    }
    if (!window.confirm(`Remove technician "${t.name}"? Their lock is removed from the inventory too.`)) return
    try {
      await deleteTechnician(t.id)
      toast.success('Removed')
    } catch (err) {
      toastCaught(err, 'Could not remove')
    }
  }

  async function toggleActive(t) {
    try {
      await updateTechnician(t.id, { active: t.active === false })
    } catch (err) {
      toastCaught(err, 'Update failed')
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>} />}
        title="Authorized LOTO Technicians"
        subtitle={
          isManager
            ? 'Maintain the list of technicians and their dedicated lock numbers.'
            : 'Who may apply LOTO locks, and their lock numbers. A manager maintains this list.'
        }
      />

      {/* Add form */}
      {isManager && (
      <Card animate={false} className="mt-6 !p-5">
        <form onSubmit={onAdd} className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Technician name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Jordan Mills"
          />
          <Input
            label="Dedicated lock no."
            value={form.lockNo}
            onChange={(e) => setForm((f) => ({ ...f, lockNo: e.target.value }))}
            placeholder="LK-014"
          />
          <Input
            label="Contact (optional)"
            value={form.contact}
            onChange={(e) => setForm((f) => ({ ...f, contact: e.target.value }))}
            placeholder="phone / email"
          />
          <Input
            label="Wireman licence number"
            value={form.licenceNo}
            onChange={(e) => setForm((f) => ({ ...f, licenceNo: e.target.value }))}
          />
          <Input
            label="Licence expiry"
            type="date"
            value={form.licenceExp}
            onChange={(e) => setForm((f) => ({ ...f, licenceExp: e.target.value }))}
          />
          <div className="flex items-end">
            <Button type="submit" loading={saving}>Add</Button>
          </div>
        </form>
      </Card>
      )}

      <div className="mt-4">
        {loading ? (
          <div className="py-16">
            <Spinner label="Loading technicians…" />
          </div>
        ) : technicians.length === 0 ? (
          <EmptyState
            title="No technicians yet"
            subtitle={isManager ? 'Add your first authorized technician above.' : 'A manager has not added any yet.'}
            icon={<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>}
          />
        ) : (
          <Card animate={false} className="overflow-hidden !p-0">
            <ul className="divide-y divide-steel-700/60">
              {technicians.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-steel-700 font-bold text-steel-100">
                      {t.name?.[0]?.toUpperCase() || '?'}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-steel-100">
                        {t.name}
                        {t.active === false && (
                          <span className="ml-2 rounded bg-steel-800 px-1.5 py-0.5 text-[10px] font-bold text-steel-400">
                            INACTIVE
                          </span>
                        )}
                      </div>
                      {t.contact && <div className="truncate text-xs text-steel-400">{t.contact}</div>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-md bg-hazard px-2.5 py-1 text-xs font-bold text-ink">
                      #{t.lockNo || '—'}
                    </span>
                    {isManager && (
                    <>
                    <button
                      onClick={() => toggleActive(t)}
                      className="rounded-lg border border-steel-700 px-2.5 py-1 text-xs font-medium text-steel-300 hover:border-steel-500"
                    >
                      {t.active === false ? 'Activate' : 'Deactivate'}
                    </button>
                    <button
                      onClick={() => onDelete(t)}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
                    >
                      Delete
                    </button>
                    </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  )
}
