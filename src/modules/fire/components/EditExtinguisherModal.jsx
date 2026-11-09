import { useEffect, useState } from 'react'
import { Save, Hash } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Modal, Spinner, Field } from './ui'
import { updateExtinguisher } from '../lib/firestore'
import { TYPES, CAPACITIES } from '../lib/constants'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'

/**
 * Edit an existing extinguisher's spec/dates. Serial No is read-only (it's the
 * CSV-match identity). Saving reuses updateExtinguisher, which also rewrites the
 * public QR mirror.
 *
 * Props: open, onClose, ext, orgId, orgName
 */
export default function EditExtinguisherModal({ open, onClose, ext, orgName, actor }) {
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const sites = useAccessibleSites()

  useEffect(() => {
    if (ext) {
      setForm({
        type: ext.type || TYPES[0],
        capacity: ext.capacity || CAPACITIES[0],
        entity: ext.entity || '',
        region: ext.region || '',
        centerName: ext.centerName || '',
        siteName: ext.siteName || '',
        siteId: ext.siteId || '',
        dateOfDeployment: ext.dateOfDeployment || '',
        dateOfNextRefill: ext.dateOfNextRefill || '',
        dateOfNextHPT: ext.dateOfNextHPT || '',
      })
    }
  }, [ext])

  if (!ext || !form) return null
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  // SiteScopePicker returns a flat map with siteId, site (name), region, entity, etc.
  const handleSiteChange = (scope) => {
    setForm({
      ...form,
      siteId: scope.siteId || '',
      centerName: scope.site || '',
      siteName: scope.site || '',
      region: scope.region || '',
      entity: scope.entity || '',
    })
  }

  const save = async () => {
    if (!form.centerName.trim()) return toast.error('Site is required')
    setBusy(true)
    try {
      await updateExtinguisher(orgName, ext.id, form, { actor })
      toast.success('Extinguisher updated')
      onClose?.()
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit extinguisher" maxWidth="max-w-2xl">
      <Field label="Serial No (read-only)" className="mb-4">
        <div className="relative">
          <Hash size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9 text-ink-500" value={ext.serialNo || '—'} readOnly disabled />
        </div>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          <select className="input" value={form.type} onChange={set('type')}>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Capacity">
          <select className="input" value={form.capacity} onChange={set('capacity')}>
            {CAPACITIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      </div>

      {/* Site scope picker replaces the old free-text "Center Name" input.
          It populates Region, Entity, and Site from the org's site registry,
          filtered by the user's site-scope permissions. */}
      <div className="mt-4">
        <SiteScopePicker
          sites={sites}
          module="equipment"
          value={{
            siteId: form.siteId,
            site: form.centerName,
            region: form.region,
            entity: form.entity,
          }}
          onChange={handleSiteChange}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Date of Deployment">
          <input type="date" className="input" value={form.dateOfDeployment} onChange={set('dateOfDeployment')} />
        </Field>
        <Field label="Date of Next Refill">
          <input type="date" className="input" value={form.dateOfNextRefill} onChange={set('dateOfNextRefill')} />
        </Field>
        <Field label="Date of Next HPT">
          <input type="date" className="input" value={form.dateOfNextHPT} onChange={set('dateOfNextHPT')} />
        </Field>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={busy}>
          {busy ? <Spinner size={18} /> : (<><Save size={16} /> Save changes</>)}
        </button>
      </div>
    </Modal>
  )
}
