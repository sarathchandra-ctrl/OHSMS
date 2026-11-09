import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PhoneCall, Phone, Plus, Pencil, Trash2, Wand2, Globe2, MapPin } from 'lucide-react'
import {
  Card,
  Field,
  Input,
  Select,
  Textarea,
  Button,
  Modal,
  Badge,
  EmptyState,
} from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import DeptPersonPicker from '../../../shared/org/DeptPersonPicker'
import {
  addContact,
  updateContact,
  deleteContact,
  EXTERNAL_ROLES,
  INTERNAL_ROLES,
} from '../lib/firestore'
import { findNearestServices, activeProvider } from '../lib/nearby'
import { autofillSite, planContactWrite } from '../lib/autofill'
import { erpRoleLabel } from '../../../shared/org/erpRoles'
import { useErpRoleLabels } from '../../../shared/org/useErpRoleLabels'

const EMPTY = {
  kind: 'external',
  role: 'Police',
  customRole: '',
  name: '',
  phone: '',
  altPhone: '',
  email: '',
  employeeUid: '',
  department: '',
  address: '',
  notes: '',
  orgWide: false,
}

/** Escalation order for internal roles; unknown roles last. */
const roleRank = (role) => {
  const i = INTERNAL_ROLES.indexOf(role)
  return i === -1 ? 99 : i
}

function ContactRow({ c, tone, isManager, onEdit, onDelete, roleLabels }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <Badge tone={tone}>{c.kind === 'internal' ? erpRoleLabel(c.role, roleLabels) : c.role}</Badge>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-ink-900">{c.name}</p>
        <p className="truncate text-xs text-ink-400">
          {[
            c.distanceKm != null && c.distanceKm !== '' ? `~${c.distanceKm} km` : '',
            c.address,
            c.department,
            c.email,
            !c.siteId && 'all sites',
          ]
            .filter(Boolean)
            .join(' · ')}
          {c.notes
            ? `${c.address || c.department || c.email || c.distanceKm != null || !c.siteId ? ' · ' : ''}${c.notes}`
            : ''}
        </p>
      </div>
      {c.phone ? (
        <a
          href={`tel:${c.phone}`}
          className={`shrink-0 rounded-xl px-3 py-1.5 text-sm font-bold transition ${
            tone === 'red'
              ? 'bg-red-50 text-red-700 hover:bg-red-100'
              : 'text-brand-700 hover:underline'
          }`}
        >
          {c.phone}
        </a>
      ) : (
        <span className="shrink-0 text-xs font-semibold text-amber-700">No number</span>
      )}
      {isManager && (
        <div className="flex shrink-0 gap-0.5">
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onEdit(c)} title="Edit">
            <Pencil size={13} />
          </button>
          <button
            className="btn-ghost px-2 py-1 text-xs text-red-600 hover:bg-red-50"
            onClick={() => onDelete(c)}
            title="Remove"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </li>
  )
}

/**
 * A site's emergency contacts: external services (with nearest-services
 * auto-fill from the site's coordinates) and the internal escalation chain.
 * Contacts default to this site; tick "all sites" for org-wide entries.
 */
export default function ContactsSection({ site, contacts, users }) {
  const roleLabels = useErpRoleLabels()
  const { actor, isManager } = useAuth()
  const [editing, setEditing] = useState(null) // 'new' | contact | null
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)

  const [autoOpen, setAutoOpen] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoResults, setAutoResults] = useState(null)
  const [replaceManual, setReplaceManual] = useState(false)
  const contactsReady = Array.isArray(contacts)

  const mine = useMemo(
    () => (contacts || []).filter((c) => !c.siteId || c.siteId === site.id),
    [contacts, site]
  )
  const external = useMemo(
    () => mine.filter((c) => c.kind === 'external').sort((a, b) => a.role.localeCompare(b.role)),
    [mine]
  )
  const internal = useMemo(
    () =>
      mine
        .filter((c) => c.kind === 'internal')
        .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name)),
    [mine]
  )

  const openNew = (kind) => {
    setForm({ ...EMPTY, kind, role: kind === 'internal' ? 'CM' : 'Police' })
    setEditing('new')
  }
  const openEdit = (c) => {
    const known = (c.kind === 'internal' ? INTERNAL_ROLES : EXTERNAL_ROLES).includes(c.role)
    setForm({
      ...EMPTY,
      ...c,
      role: known ? c.role : 'Other',
      customRole: known ? '' : c.role,
      orgWide: !c.siteId,
    })
    setEditing(c)
  }

  const save = async (e) => {
    e.preventDefault()
    const role = form.role === 'Other' ? form.customRole.trim() : form.role
    if (!role) return toast.error('Enter the role')
    if (!form.name.trim()) return toast.error('Enter the contact name')
    if (!form.phone.trim()) return toast.error('Enter the phone number')
    setBusy(true)
    try {
      const scope = form.orgWide
        ? { region: '', entity: '', siteId: '', site: '' }
        : { region: site.region || '', entity: site.entity || '', siteId: site.id, site: site.name }
      // Saving from this form is a person deciding what the contact is.
      // That has to win over the next "Map nearest", including when they
      // correct a row the lookup wrote and leave its note in place.
      const nameChanged = editing !== 'new' && form.name.trim() !== editing.name
      const payload = {
        ...form,
        role,
        ...scope,
        origin: 'manual',
        address: form.address || '',
        distanceKm: nameChanged ? null : (editing?.distanceKm ?? null),
      }
      if (editing === 'new') {
        await addContact(payload, actor)
        toast.success('Contact added')
      } else {
        await updateContact(editing.id, payload, actor)
        toast.success('Contact updated')
      }
      setEditing(null)
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (c) => {
    if (!window.confirm(`Remove ${c.role} contact "${c.name}"?`)) return
    try {
      await deleteContact(c.id, actor, `${c.role} · ${c.name}`)
      toast.success('Contact removed')
    } catch (err) {
      toastCaught(err, 'Failed')
    }
  }

  // ── Nearest Police / Hospital / Fire from this site's coordinates ──
  const hasCoords = site.lat != null && site.lng != null

  const runAutoFill = async () => {
    setAutoBusy(true)
    setAutoResults(null)
    try {
      const found = await findNearestServices(site.lat, site.lng)
      if (!found.length) toast.error('No named services found nearby')
      setAutoResults(found)
    } catch (err) {
      toastCaught(err, 'Map lookup failed')
    } finally {
      setAutoBusy(false)
    }
  }

  const applyAutoFill = async () => {
    if (!autoResults?.length) return
    setAutoBusy(true)
    try {
      const { added, updated, skipped, withoutNumber } = await autofillSite(
        site,
        contacts,
        actor,
        { replaceManual }
      )
      toast.success(
        `${added} contact(s) added${updated ? `, ${updated} updated` : ''}` +
          (skipped ? ` · ${skipped} you entered kept` : '') +
          (withoutNumber ? ` · ${withoutNumber} need a number entered manually` : '')
      )
      setAutoOpen(false)
      setAutoResults(null)
    } catch (err) {
      toastCaught(err, 'Failed to save contacts')
    } finally {
      setAutoBusy(false)
    }
  }

  const roles = form.kind === 'internal' ? INTERNAL_ROLES : EXTERNAL_ROLES

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        {/* External services */}
        <Card className="overflow-hidden !p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-2 pt-4">
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <PhoneCall size={17} className="text-red-600" /> External services ({external.length})
            </h3>
            {isManager && (
              <div className="flex gap-1.5">
                <Button
                  variant="soft"
                  icon={Wand2}
                  className="!py-1.5 text-xs"
                  disabled={!hasCoords || !contactsReady}
                  title={
                    !hasCoords
                      ? 'Add coordinates to this site first'
                      : !contactsReady
                        ? 'Contacts are still loading'
                        : 'Find nearest Police, Hospital and Fire station'
                  }
                  onClick={() => {
                    setAutoResults(null)
                    setReplaceManual(false)
                    setAutoOpen(true)
                  }}
                >
                  Map nearest
                </Button>
                <Button icon={Plus} className="!py-1.5 text-xs" onClick={() => openNew('external')}>
                  Add
                </Button>
              </div>
            )}
          </div>
          {external.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={PhoneCall}
                title="No external contacts"
                description={
                  hasCoords
                    ? 'Use “Map nearest” to pull the closest Police station, Hospital and Fire station from the site’s coordinates — or add them manually.'
                    : 'Add Police, Ambulance, Fire Brigade and Hospital numbers for this site.'
                }
                action={
                  isManager &&
                  hasCoords && (
                    <Button icon={Wand2} onClick={() => setAutoOpen(true)}>
                      Map nearest
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-surface-200/60">
              {external.map((c) => (
                <ContactRow
                  key={c.id}
                  c={c}
                  tone="red"
                  isManager={isManager}
                  onEdit={openEdit}
                  onDelete={remove}
                  roleLabels={roleLabels}
                />
              ))}
            </ul>
          )}
        </Card>

        {/* Internal escalation */}
        <Card className="overflow-hidden !p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-2 pt-4">
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <Phone size={17} className="text-brand-600" /> Internal escalation ({internal.length})
            </h3>
            {isManager && (
              <Button icon={Plus} className="!py-1.5 text-xs" onClick={() => openNew('internal')}>
                Add
              </Button>
            )}
          </div>
          {internal.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={Phone}
                title="No internal contacts"
                description="Add this site's CM, CLM, Safety L1/L2, Legal and HR contacts."
              />
            </div>
          ) : (
            <ul className="divide-y divide-surface-200/60">
              {internal.map((c) => (
                <ContactRow
                  key={c.id}
                  c={c}
                  tone="brand"
                  isManager={isManager}
                  onEdit={openEdit}
                  onDelete={remove}
                  roleLabels={roleLabels}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ── Add / edit contact ── */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? `Add contact — ${site.name}` : 'Edit contact'}
        size="lg"
      >
        <form onSubmit={save} className="space-y-4 p-6">
          <div className="flex gap-2">
            {['external', 'internal'].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    kind: k,
                    role: k === 'internal' ? 'CM' : 'Police',
                    employeeUid: '',
                    department: '',
                  }))
                }
                className={`flex-1 rounded-xl px-3 py-2 text-sm font-bold transition ${form.kind === k ? 'bg-brand-600 text-white shadow-elev-brand' : 'bg-surface text-ink-600 shadow-elev-sm'}`}
              >
                {k === 'external' ? 'External service' : 'Internal contact'}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role *">
              <Select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {form.kind === 'internal' ? erpRoleLabel(r, roleLabels) : r}
                  </option>
                ))}
              </Select>
            </Field>
            {form.role === 'Other' && (
              <Field label="Custom role *">
                <Input
                  value={form.customRole}
                  onChange={(e) => setForm({ ...form, customRole: e.target.value })}
                  placeholder="e.g. Poison Control"
                />
              </Field>
            )}
          </div>

          {form.kind === 'internal' && (
            <Field label="Pick from employee directory — Department · Person">
              <DeptPersonPicker
                users={users}
                value={form.employeeUid}
                onChange={(v, u) =>
                  setForm((f) => ({
                    ...f,
                    employeeUid: v,
                    name: u?.name || f.name,
                    email: u?.email || f.email,
                    department: u?.department || u?.dept || f.department,
                  }))
                }
                personPlaceholder="Select employee…"
              />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name *">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={
                  form.kind === 'external' ? 'e.g. Elland Road Police Station' : 'Contact name'
                }
              />
            </Field>
            <Field label="Phone *">
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="e.g. 112 / +91 …"
              />
            </Field>
            <Field label="Alternate phone">
              <Input
                value={form.altPhone}
                onChange={(e) => setForm({ ...form, altPhone: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            {form.kind === 'external' && (
              <Field label="Address" className="sm:col-span-2">
                <Input
                  value={form.address || ''}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Street, area, city"
                />
              </Field>
            )}
          </div>

          <label className="ring-1 ring-ink-200 flex items-center gap-2.5 rounded-xl bg-surface-50 px-3.5 py-2.5 ">
            <input
              type="checkbox"
              className="h-4 w-4 accent-current text-brand-600"
              checked={form.orgWide}
              onChange={(e) => setForm({ ...form, orgWide: e.target.checked })}
            />
            <span className="text-sm text-ink-700">
              <Globe2 size={13} className="mr-1 inline text-ink-400" />
              Applies to <b>all sites</b> (org-wide contact)
              <span className="ml-1 text-xs text-ink-400">
                — otherwise it belongs to {site.name}
              </span>
            </span>
          </label>

          <Field label="Notes">
            <Textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="e.g. 24×7 control room; ask for the duty officer"
            />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {editing === 'new' ? 'Add contact' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Map nearest services ── */}
      <Modal
        open={autoOpen}
        onClose={() => setAutoOpen(false)}
        title={`Map nearest services — ${site.name}`}
        size="lg"
      >
        <div className="space-y-4 p-6">
          <p className="-mt-1 text-sm text-ink-500">
            Finds the closest <b>Hospital</b>, <b>Police station</b> and <b>Fire station</b> to this
            site&apos;s coordinates (
            {activeProvider() === 'google'
              ? 'Google Places, with OpenStreetMap if that fails'
              : 'OpenStreetMap'}
            ) and saves the name, phone where one is published, address and straight-line distance.
            Contacts you entered or edited yourself are kept.
          </p>
          <div className="ring-1 ring-ink-200 flex flex-wrap items-center gap-3 rounded-xl bg-surface-50 px-3.5 py-2.5 text-sm ">
            <MapPin size={15} className="text-brand-600" />
            <span className="text-ink-700">
              {hasCoords ? (
                <>
                  {site.name} —{' '}
                  <span className="font-mono text-xs">
                    {site.lat}, {site.lng}
                  </span>
                </>
              ) : (
                'This site has no coordinates yet — add them in the Sites module.'
              )}
            </span>
          </div>
          <Button
            type="button"
            icon={Wand2}
            loading={autoBusy && !autoResults}
            disabled={!hasCoords}
            onClick={runAutoFill}
          >
            Find nearest services
          </Button>

          {autoResults && autoResults.length > 0 && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {autoResults.map((r) => (
                  <div
                    key={r.role}
                    className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3.5 "
                  >
                    <p className="text-xs font-bold uppercase tracking-widest text-ink-400">
                      {r.role}
                    </p>
                    <p className="mt-1 font-semibold leading-snug text-ink-900">{r.name}</p>
                    {r.phone ? (
                      <p className="mt-1 text-sm font-bold text-red-700">{r.phone}</p>
                    ) : (
                      <p className="mt-1 text-sm font-bold text-amber-600">No number published</p>
                    )}
                    {r.address ? <p className="mt-1 text-xs text-ink-500">{r.address}</p> : null}
                    <p className="mt-1 text-xs text-ink-400">
                      ~{r.distanceKm} km straight-line
                      {r.phoneSource === 'none' && ' · no published number — add it after saving'}
                      {r.limited && ' · specialty or non-emergency unit'}
                      {r.fallback &&
                        ` · no ${r.role.toLowerCase()} tagged within ${r.searchedKm} km`}
                      {r.source === 'google' && ' · Google'}
                      {r.source === 'nominatim' && ' · approximate — confirm'}
                    </p>
                    {(() => {
                      const rows = (contacts || []).filter(
                        (c) => c.kind === 'external' && c.siteId === site.id && c.role === r.role
                      )
                      const plan = planContactWrite(rows, { replaceManual })
                      if (plan.action === 'skip') {
                        return (
                          <p className="mt-1 text-xs font-medium text-amber-800">
                            Your own {r.role} contact is kept.
                          </p>
                        )
                      }
                      return null
                    })()}
                  </div>
                ))}
              </div>
              <label className="flex items-start gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-current text-brand-600"
                  checked={replaceManual}
                  onChange={(e) => setReplaceManual(e.target.checked)}
                />
                <span>Also replace contacts I entered myself</span>
              </label>
              <div className="flex justify-end">
                <Button
                  type="button"
                  icon={Plus}
                  loading={autoBusy}
                  disabled={!contactsReady}
                  onClick={applyAutoFill}
                >
                  Save {autoResults.length} contact{autoResults.length === 1 ? '' : 's'}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
