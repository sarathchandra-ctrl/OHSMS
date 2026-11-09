import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../lib/toastCaught'
import { useAuth } from '../auth/AuthContext'
import { subscribeSites, requestAccess } from '../org/orgData'
import { orgDepartments, regionsOf, entitiesOf } from '../auth/access'
import { Modal, Button, Field, Select, MultiSelect } from '../ui'

// Lets an approved member request site-scoped access; the request is routed to
// admins (who grant it from the Users page).
export default function RequestAccessModal({ open, onClose }) {
  const { actor, user, profile, org } = useAuth()
  const [sites, setSites] = useState([])
  const [form, setForm] = useState({ department: '', sites: [], regions: [], entities: [] })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if ((!open)) return
    return subscribeSites(setSites)
  }, [open])

  useEffect(() => {
    if (open) setForm((f) => ({ ...f, department: profile?.department || f.department }))
  }, [open, profile])

  const regions = useMemo(() => regionsOf(sites), [sites])
  const entities = useMemo(() => entitiesOf(sites), [sites])
  const siteOptions = useMemo(() => sites.map((s) => ({ value: s.id, label: s.name })), [sites])

  const submit = async (e) => {
    e.preventDefault()
    if (form.sites.length + form.regions.length + form.entities.length === 0) {
      return toast.error('Select at least one entity, region or site')
    }
    setBusy(true)
    try {
      await requestAccess(
        user.uid,
        { department: form.department, scope: { sites: form.sites, regions: form.regions, entities: form.entities } },
        actor
      )
      toast.success('Access request sent to your administrators')
      onClose()
      setForm({ department: '', sites: [], regions: [], entities: [] })
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Request site access"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button form="req-access" type="submit" loading={busy}>Send request</Button>
        </>
      }
    >
      <form id="req-access" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-ink-500">
          Choose the <b>entity</b>, <b>region</b> and/or specific <b>sites</b> you need. An entity or region
          grants access to all its sites. Your request is sent to an administrator for approval.
        </p>
        <Field label="Department" htmlFor="req-dept">
          <Select id="req-dept" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
            <option value="">—</option>
            {orgDepartments(org).map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={`Entities (${form.entities.length})`}>
            <MultiSelect options={entities} value={form.entities} onChange={(entities) => setForm({ ...form, entities })} empty="No entities yet" />
          </Field>
          <Field label={`Regions (${form.regions.length})`}>
            <MultiSelect options={regions} value={form.regions} onChange={(regions) => setForm({ ...form, regions })} empty="No regions yet" />
          </Field>
          <Field label={`Sites (${form.sites.length})`}>
            <MultiSelect options={siteOptions} value={form.sites} onChange={(s) => setForm({ ...form, sites: s })} empty="No sites yet" />
          </Field>
        </div>
      </form>
    </Modal>
  )
}
