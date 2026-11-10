import { useMemo, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Ambulance, Plus, Pencil, Trash2, Search, Filter, X, Download, QrCode, Wrench, Upload, AlertTriangle, MapPin } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Badge, Spinner, Field } from '../components/ui'
import { Pager, IconButton } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import {
  addStretcher, updateStretcher, deleteStretcher, serviceStretcher,
  generateStretcherQr, bulkDeleteStretchers, linkStretchersToSites, reserveAssetIds,
} from '../lib/data'
import { planSiteLinks } from '../lib/siteLink'
import { listLinkedAssets, filterByLinkState, siteIdSet, isLinkedToSite } from '../lib/linkedSites'
import LinkSitesModal from '../components/LinkSitesModal'
import LinkStateChips from '../components/LinkStateChips'
import ChipRow from '../components/ChipRow'
import { exportRows } from '../lib/exporter'
import { publicQrUrl } from '../lib/qr'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import IncompleteNotice from '../../../shared/ui/IncompleteNotice'
import { format } from 'date-fns'
import { dueState, dueTextColor, stretcherColor, stretcherIncomplete, highestAssetSeq } from '../lib/assetLogic'
import { toDate } from '../lib/extinguisherLogic'
import {
  REGIONS, ENTITIES, STRETCHER_TYPES,
  STRETCHER_STATUS, STRETCHER_STATUS_LABEL, STRETCHER_STATUS_COLOR,
} from '../lib/constants'

// ─────────────────────────────────────────────────────────────────────────────
// Stretchers, kept in the AED's shape rather than signage's.
//
// A stretcher is one physical object in one place, and the question asked of it
// is whether THIS unit is usable — which is answered by a person standing in
// front of it, not by a site-level count. That is what makes the QR, the public
// defect sheet and the inspection cycle the right machinery here, and it is why
// this page reads like the AED repository and the First Aid page does not.
// ─────────────────────────────────────────────────────────────────────────────

const fmtDate = (v) => { const d = toDate(v); return d ? format(d, 'dd MMM yyyy') : String(v || '') }

const EMPTY = {
  assetId: '', type: STRETCHER_TYPES[0], brand: '', model: '', centerName: '', region: '', entity: '', siteId: '',
  location: '', status: STRETCHER_STATUS.READY, installDate: '', lastInspection: '', nextInspection: '', notes: '',
}
const STATUSES = Object.values(STRETCHER_STATUS)

// Date cell that highlights when a date is expired / due soon.
function DateCell({ value }) {
  const s = dueState(value)
  if (!value) return <span className="text-ink-300">—</span>
  return <span style={{ color: dueTextColor(s) }} className="font-medium">{fmtDate(value)}</span>
}

export default function Stretchers() {
  const { orgName, profile, isAdmin } = useAuth()
  const { stretchers, siteInventory, incomplete, loading } = useFleet()
  const today = useMemo(() => new Date(), [])

  const [f, setF] = useState({ search: '', regions: [], entities: [], types: [], statuses: [] })
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [qrFor, setQrFor] = useState(null)
  const [serviceFor, setServiceFor] = useState(null)
  const [nextDate, setNextDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkTab, setLinkTab] = useState('linked')
  const [linkState, setLinkState] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkRemoving, setBulkRemoving] = useState(false)

  // Stretchers arrive from the same free-text world as every other register.
  // Linking attaches each to the site registry, takes its entity from there,
  // and adopts the registry's wording so the same building is not called two
  // things across modules.
  const linkPlan = useMemo(
    () => (siteInventory.length ? planSiteLinks(stretchers, siteInventory) : null),
    [stretchers, siteInventory]
  )
  const linkedRows = useMemo(() => listLinkedAssets(stretchers, siteInventory), [stretchers, siteInventory])
  // Counts over the whole register rather than the filtered view — a chip that
  // renumbered itself as you filtered would be reporting the filter back to you.
  const linkCounts = useMemo(() => {
    const ids = siteIdSet(siteInventory)
    let linked = 0
    for (const a of stretchers) if (isLinkedToSite(a, ids)) linked += 1
    return { linked, unlinked: stretchers.length - linked }
  }, [stretchers, siteInventory])

  const doLinkSites = async () => {
    if (!linkPlan?.linked.length) return
    setBusy(true)
    try {
      const r = await linkStretchersToSites(orgName, linkPlan, { uid: profile?.uid, name: profile?.name })
      toast.success(`${r.linked} linked · ${r.nameChanges} renamed · ${r.entityChanges} entity value(s) corrected`)
      setLinkOpen(false)
    } catch (e) {
      toastCaught(e, 'Could not link to sites')
    } finally { setBusy(false) }
  }

  // Open the Add form with an asset ID RESERVED, not guessed. See AEDRepository:
  // the highest-in-the-loaded-list arithmetic handed two people the same number,
  // and that number goes on the QR label.
  const openAdd = async () => {
    try {
      const [assetId] = await reserveAssetIds('stretcher', 'STR', {
        floor: highestAssetSeq('STR', stretchers, 'assetId'),
      })
      setEditing({ ...EMPTY, assetId })
    } catch (e) {
      toastCaught(e, 'Could not reserve an asset ID')
    }
  }

  const toggle = (field, v) => setF((p) => ({ ...p, [field]: p[field].includes(v) ? p[field].filter((x) => x !== v) : [...p[field], v] }))
  const anyActive = f.search || f.regions.length || f.entities.length || f.types.length || f.statuses.length
  const clear = () => setF({ search: '', regions: [], entities: [], types: [], statuses: [] })

  const visible = useMemo(() => {
    const q = f.search.trim().toLowerCase()
    return filterByLinkState(stretchers, siteInventory, linkState).filter((a) => {
      if (f.regions.length && !f.regions.includes(a.region)) return false
      if (f.entities.length && !f.entities.includes(a.entity)) return false
      if (f.types.length && !f.types.includes(a.type)) return false
      if (f.statuses.length && !f.statuses.includes(a.status)) return false
      if (q && !`${a.assetId} ${a.type} ${a.brand} ${a.model} ${a.centerName} ${a.location}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [stretchers, f, siteInventory, linkState])

  // Changing a filter drops the selection — the rows it referred to may no
  // longer be on screen. (The page itself needs no reset; usePagination clamps.)
  useEffect(() => { setSelected(new Set()) }, [f])
  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(visible)

  // ── Row selection + bulk delete ──
  const toggleSel = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const pageIds = pageItems.map((a) => a.id)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const toggleAllOnPage = () => setSelected((prev) => {
    const n = new Set(prev)
    if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id))
    return n
  })
  const confirmBulkDelete = async () => {
    const items = stretchers.filter((a) => selected.has(a.id)).map((a) => ({ id: a.id, qrToken: a.qrToken }))
    setBusy(true)
    try {
      await bulkDeleteStretchers(items, { uid: profile?.uid, name: profile?.name })
      toast.success(`${items.length} stretcher(s) deleted`)
      setSelected(new Set()); setBulkRemoving(false)
    } catch (e) { toastCaught(e) } finally { setBusy(false) }
  }

  const save = async (e) => {
    e.preventDefault()
    // Details can be filled in later — records save even when incomplete
    // (they're flagged as "data not available" on the dashboard/repository).
    setBusy(true)
    try {
      const actor = { uid: profile?.uid, name: profile?.name }
      if (editing.id) { await updateStretcher(orgName, editing.id, editing, actor); toast.success('Stretcher updated') }
      else { await addStretcher(orgName, editing, actor); toast.success('Stretcher added') }
      setEditing(null)
    } catch (err) { toastCaught(err) } finally { setBusy(false) }
  }

  const confirmDelete = async () => {
    try {
      await deleteStretcher(removing.id, removing.qrToken, { uid: profile?.uid, name: profile?.name }, `${removing.assetId || 'Stretcher'} @ ${removing.centerName}`)
      toast.success('Stretcher deleted')
    } catch (err) { toastCaught(err) } finally { setRemoving(null) }
  }

  // View the QR — or, for admins, mint one first if the record lacks it.
  const showQr = async (a) => {
    if (a.qrToken) { setQrFor(a); return }
    if (!isAdmin) { toast.error('Only an admin can generate QR codes'); return }
    setBusy(true)
    try {
      const token = await generateStretcherQr(orgName, a, { uid: profile?.uid, name: profile?.name })
      setQrFor({ ...a, qrToken: token })
      toast.success('QR code generated')
    } catch (e) { toastCaught(e) } finally { setBusy(false) }
  }

  const openService = (a) => { setServiceFor(a); setNextDate(a.nextInspection || '') }
  const confirmService = async () => {
    setBusy(true)
    try {
      await serviceStretcher(orgName, serviceFor, nextDate, { uid: profile?.uid, name: profile?.name })
      toast.success('Inspection logged')
      setServiceFor(null)
    } catch (err) { toastCaught(err) } finally { setBusy(false) }
  }

  const doExport = () => {
    if (!visible.length) return toast.error('Nothing to export')
    exportRows(visible.map((a) => ({
      'Asset ID': a.assetId, Type: a.type, Brand: a.brand, Model: a.model, Site: a.centerName, Region: a.region,
      Entity: a.entity, Location: a.location, Status: STRETCHER_STATUS_LABEL[a.status] || a.status,
      'Install Date': a.installDate, 'Last Inspection': a.lastInspection, 'Next Inspection': a.nextInspection,
      Notes: a.notes,
    })), 'Stretchers', 'ohs-stretchers.xlsx')
    toast.success('Exported to Excel')
  }

  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.value })

  return (
    <div>
      <PageHeader title="Stretcher Repository" subtitle={`${visible.length}${anyActive ? ` of ${stretchers.length}` : ''} stretcher${visible.length === 1 ? '' : 's'}`} icon={Ambulance}>
        {isAdmin && (
          <button
            className={linkPlan?.linked.length ? 'btn-soft !bg-brand-100 !text-brand-800' : 'btn-soft'}
            onClick={() => { setLinkTab(linkPlan?.linked.length ? 'pending' : 'linked'); setLinkOpen(true) }}
            disabled={busy}
            title="Which stretchers are attached to a site, and which can still be matched to one"
          >
            <MapPin size={16} />
            {linkPlan?.linked.length ? `Link ${linkPlan.linked.length} to sites` : `Site links (${linkedRows.length})`}
          </button>
        )}
        {isAdmin && <Link to="/equipment/asset-bulk-upload" state={{ kind: 'stretcher' }} className="btn-soft"><Upload size={16} /> Bulk upload</Link>}
        <button className="btn-soft" onClick={doExport} disabled={!stretchers.length}><Download size={16} /> Export</button>
        <button className="btn-primary" onClick={openAdd}><Plus size={16} /> Add stretcher</button>
      </PageHeader>

      <IncompleteNotice incomplete={incomplete} className="mb-4" />

      {!loading && stretchers.length > 0 && (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400"><Filter size={13} /> Filters</span>
            <div className="relative min-w-[200px] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input className="input pl-9" placeholder="Search asset ID, type, site…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
            </div>
            {anyActive ? <button className="btn-ghost" onClick={clear}><X size={15} /> Clear</button> : null}
          </div>
          <ChipRow label="Region" options={REGIONS} selected={f.regions} onToggle={(v) => toggle('regions', v)} />
          <ChipRow label="Entity" options={ENTITIES} selected={f.entities} onToggle={(v) => toggle('entities', v)} />
          <ChipRow label="Type" options={STRETCHER_TYPES} selected={f.types} onToggle={(v) => toggle('types', v)} />
          <ChipRow label="Status" options={STATUSES} selected={f.statuses} onToggle={(v) => toggle('statuses', v)} render={(s) => STRETCHER_STATUS_LABEL[s]} />
          {linkCounts.linked > 0 && linkCounts.unlinked > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-ink-400">Site link</span>
              <LinkStateChips value={linkState} onChange={setLinkState} linkedCount={linkCounts.linked} unlinkedCount={linkCounts.unlinked} />
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="grid place-items-center py-20"><Spinner size={28} /></div>
      ) : stretchers.length === 0 ? (
        <EmptyState icon={Ambulance} title="No stretchers yet" hint="Add your first stretcher to start tracking its location, condition and inspection due date."
          action={<button className="btn-primary" onClick={openAdd}><Plus size={16} /> Add stretcher</button>} />
      ) : visible.length === 0 ? (
        <EmptyState icon={Filter} title="No matches" hint="Try adjusting the filters." action={<button className="btn-ghost" onClick={clear}><X size={15} /> Clear filters</button>} />
      ) : (
        <>
          {selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-50 px-4 py-2.5 text-sm">
              <span className="font-semibold text-brand-700">{selected.size} selected</span>
              <div className="flex gap-2">
                <button className="btn-ghost px-3 py-1.5" onClick={() => setSelected(new Set())}>Clear</button>
                <button className="btn-danger px-3 py-1.5" onClick={() => setBulkRemoving(true)}><Trash2 size={15} /> Delete selected</button>
              </div>
            </div>
          )}
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-surface-100/70 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3"><input type="checkbox" className="h-4 w-4 cursor-pointer accent-brand-500" checked={allOnPage} onChange={toggleAllOnPage} aria-label="Select all stretchers on this page" title="Select all on this page" /></th>
                  <th className="px-4 py-3">Asset ID</th><th className="px-4 py-3">Site</th><th className="px-4 py-3">Region</th>
                  <th className="px-4 py-3">Last Inspection</th><th className="px-4 py-3">Next Inspection</th>
                  <th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((a) => (
                  <tr key={a.id} className={`hover:bg-ink-50/70 ${selected.has(a.id) ? 'bg-brand-50/60' : ''}`} style={{ boxShadow: `inset 4px 0 0 ${stretcherColor(a, today)}` }}>
                    <td className="px-4 py-3"><input type="checkbox" className="h-4 w-4 cursor-pointer accent-brand-500" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} aria-label={`Select ${a.assetId || 'this stretcher'}`} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 font-bold text-ink-900">
                        {a.assetId || '—'}
                        {stretcherIncomplete(a) && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Data not available — the site or the next inspection date still needs entering">
                            <AlertTriangle size={11} /> Data N/A
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-500">{[a.type, a.brand, a.model].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-ink-700">{a.centerName}{a.location ? <span className="block text-xs text-ink-400">{a.location}</span> : null}</td>
                    <td className="px-4 py-3 text-ink-600">{a.region || '—'}</td>
                    <td className="px-4 py-3"><DateCell value={a.lastInspection} /></td>
                    <td className="px-4 py-3"><DateCell value={a.nextInspection} /></td>
                    <td className="px-4 py-3"><Badge color={STRETCHER_STATUS_COLOR[a.status] || '#64748b'}>{STRETCHER_STATUS_LABEL[a.status] || a.status}</Badge></td>
                    <td className="px-4 py-3">
                      {/* Every label names the ROW, not just the verb — a screen
                          reader reads these out of the surrounding table, and
                          a column of "Edit, Delete, Edit, Delete" gives no way
                          to tell which stretcher is about to be removed. */}
                      <div className="flex justify-end gap-1">
                        <IconButton icon={Wrench} iconSize={14} label={`Log inspection for ${a.assetId || 'this stretcher'}`} className="!bg-green-600 !text-white hover:!brightness-110" onClick={() => openService(a)} />
                        <IconButton icon={QrCode} iconSize={15} variant="soft" label={a.qrToken ? `View QR code for ${a.assetId || 'this stretcher'}` : isAdmin ? `Generate QR code for ${a.assetId || 'this stretcher'}` : 'Only an admin can generate QR codes'} onClick={() => showQr(a)} disabled={busy || (!a.qrToken && !isAdmin)} />
                        <IconButton icon={Pencil} iconSize={15} variant="soft" label={`Edit ${a.assetId || 'this stretcher'}`} onClick={() => setEditing(a)} />
                        <IconButton icon={Trash2} iconSize={15} variant="soft" label={`Delete ${a.assetId || 'this stretcher'}`} className="!text-red-600" onClick={() => setRemoving(a)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager className="border-t border-ink-100 px-3 py-2" page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize} />
          </div>
        </>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit stretcher' : 'Add stretcher'}>
        {editing && (
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Asset ID (auto)"><input className="input bg-ink-50 text-ink-500" value={editing.assetId} readOnly title="Automatically assigned — unique per stretcher" /></Field>
              <Field label="Type">
                <select className="input" value={editing.type} onChange={set('type')}>{STRETCHER_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              </Field>
              <Field label="Site — Region · Entity · Site" className="sm:col-span-2">
                <SiteScopePicker
                  module="equipment"
                  sites={siteInventory}
                  value={{ ...editing, site: editing.centerName }}
                  onChange={(v) => setEditing((p) => ({ ...p, ...v, centerName: v.site }))}
                />
              </Field>
              <Field label="Brand"><input className="input" value={editing.brand} onChange={set('brand')} placeholder="e.g. Ferno" /></Field>
              <Field label="Model"><input className="input" value={editing.model} onChange={set('model')} placeholder="e.g. Model 71" /></Field>
              <Field label="Location / placement"><input className="input" value={editing.location} onChange={set('location')} placeholder="e.g. Ground floor corridor, beside the AED" /></Field>
              <Field label="Status"><select className="input" value={editing.status} onChange={set('status')}>{STATUSES.map((s) => <option key={s} value={s}>{STRETCHER_STATUS_LABEL[s]}</option>)}</select></Field>
              <Field label="Install date"><input type="date" className="input" value={editing.installDate} onChange={set('installDate')} /></Field>
              <Field label="Last inspection"><input type="date" className="input" value={editing.lastInspection} onChange={set('lastInspection')} /></Field>
              <Field label="Next inspection"><input type="date" className="input" value={editing.nextInspection} onChange={set('nextInspection')} /></Field>
            </div>
            {!editing.nextInspection && (
              <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
                Without a next-inspection date this stretcher can never fall due, so it will read as ready
                indefinitely — whether it was last checked yesterday or never.
              </p>
            )}
            <Field label="Notes"><textarea className="input" rows={2} value={editing.notes} onChange={set('notes')} /></Field>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? <Spinner size={16} /> : (editing.id ? 'Save changes' : 'Add stretcher')}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete stretcher?">
        <p className="text-sm text-ink-600">Remove <span className="font-semibold">{removing?.assetId || 'this stretcher'}</span> at <span className="font-semibold">{removing?.centerName}</span>? This can’t be undone.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn-danger" onClick={confirmDelete}>Delete</button>
        </div>
      </Modal>

      <LinkSitesModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        plan={linkPlan}
        linkedRows={linkedRows}
        initialTab={linkTab}
        onConfirm={doLinkSites}
        busy={busy}
        noun="stretcher"
        nounPlural="stretchers"
        idLabel="Asset ID"
      />

      <Modal open={bulkRemoving} onClose={() => setBulkRemoving(false)} title={`Delete ${selected.size} stretcher(s)?`}>
        <p className="text-sm text-ink-600">Permanently remove <span className="font-semibold">{selected.size}</span> selected stretcher{selected.size === 1 ? '' : 's'} and their QR codes? This can’t be undone.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setBulkRemoving(false)}>Cancel</button>
          <button className="btn-danger" onClick={confirmBulkDelete} disabled={busy}>{busy ? <Spinner size={16} /> : `Delete ${selected.size}`}</button>
        </div>
      </Modal>

      <Modal open={!!qrFor} onClose={() => setQrFor(null)} title={`QR — ${qrFor?.assetId || 'Stretcher'}`}>
        {qrFor && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="rounded-2xl bg-white p-4 shadow-elev"><QRCodeSVG value={publicQrUrl(qrFor.qrToken)} size={200} level="H" includeMargin /></div>
            <p className="text-sm font-bold text-ink-900">{qrFor.assetId || 'Stretcher'} · {qrFor.centerName}</p>
            <p className="break-all text-xs text-ink-400">{publicQrUrl(qrFor.qrToken)}</p>
            <p className="text-xs text-ink-500">Scanning opens a public status page where anyone can report a defect.</p>
          </div>
        )}
      </Modal>

      <Modal open={!!serviceFor} onClose={() => setServiceFor(null)} title="Log inspection">
        {serviceFor && (
          <div className="space-y-4">
            <p className="text-sm text-ink-600">Record an inspection for <strong>{serviceFor.assetId || 'this stretcher'}</strong> @ <strong>{serviceFor.centerName}</strong>. Last inspection is set to today and status to <strong>Ready</strong>.</p>
            <Field label="Next inspection due"><input type="date" className="input" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></Field>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setServiceFor(null)}>Cancel</button>
              <button className="btn-primary" onClick={confirmService} disabled={busy}>{busy ? <Spinner size={16} /> : 'Log inspection'}</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
