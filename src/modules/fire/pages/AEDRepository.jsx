import { useMemo, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { HeartPulse, Plus, Pencil, Trash2, Search, Filter, X, Download, QrCode, Wrench, Upload, AlertTriangle, MapPin } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Badge, Spinner, Field } from '../components/ui'
import { Pager, IconButton } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { canManageAsset } from '../lib/recycle'
import RecentlyDeletedLink from '../components/RecentlyDeletedLink'
import { addAed, updateAed, deleteAed, serviceAed, bulkAddAeds, generateAedQr, bulkDeleteAeds, linkAedsToSites, reserveAssetIds } from '../lib/data'
import { planSiteLinks } from '../lib/siteLink'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { listLinkedAssets, filterByLinkState, siteIdSet, isLinkedToSite } from '../lib/linkedSites'
import LinkSitesModal from '../components/LinkSitesModal'
import LinkStateChips from '../components/LinkStateChips'
import { exportRows } from '../lib/exporter'
import ExportQrButton from '../components/ExportQrButton'
import { publicQrUrl } from '../lib/qr'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import { format } from 'date-fns'
import { dueState, dueTextColor, aedColor, aedIncomplete, highestAssetSeq } from '../lib/assetLogic'
import { toDate } from '../lib/extinguisherLogic'
import { REGIONS, ENTITIES, AED_STATUS, AED_STATUS_LABEL, AED_STATUS_COLOR } from '../lib/constants'

// Build site → {region, entity} from existing records so AED sites auto-fill.
function useSiteMeta() {
  const { extinguishers, signages, aeds, fas } = useFleet()
  return useMemo(() => {
    const m = {}
    const add = (rows) => rows.forEach((r) => {
      const s = r.centerName
      if (!s) return
      if (!m[s]) m[s] = { region: '', entity: '' }
      if (!m[s].region && r.region) m[s].region = r.region
      if (!m[s].entity && r.entity) m[s].entity = r.entity
    })
    add(extinguishers || []); add(signages || []); add(aeds || []); add(fas || [])
    return m
  }, [extinguishers, signages, aeds, fas])
}

const fmtDate = (v) => { const d = toDate(v); return d ? format(d, 'dd MMM yyyy') : String(v || '') }

const EMPTY = {
  assetId: '', brand: '', model: '', centerName: '', region: '', entity: '', siteId: '', location: '',
  status: AED_STATUS.READY, installDate: '', batteryExpiry: '', padExpiry: '',
  lastInspection: '', nextInspection: '', notes: '',
}
const STATUSES = Object.values(AED_STATUS)

function ChipRow({ label, options, selected, onToggle, render }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
      <span className="w-16 shrink-0 text-xs font-bold uppercase tracking-wide text-ink-400">{label}</span>
      {options.map((opt) => {
        const on = selected.includes(opt)
        return (
          <button key={opt} type="button" onClick={() => onToggle(opt)}
            className={`chip transition ${on ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}>
            {render ? render(opt) : opt}
          </button>
        )
      })}
    </div>
  )
}
// Date cell that highlights when a date is expired / due soon.
function DateCell({ value }) {
  const s = dueState(value)
  if (!value) return <span className="text-ink-300">—</span>
  const color = dueTextColor(s)
  return <span style={{ color }} className="font-medium">{fmtDate(value)}</span>
}

export default function AEDRepository() {
  const { orgName, profile, isAdmin, isManager } = useAuth()
  const { aeds, sites, siteInventory, loading } = useFleet()
  const siteMeta = useSiteMeta()
  const today = useMemo(() => new Date(), [])

  const [f, setF] = useState({ search: '', regions: [], entities: [], statuses: [] })
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

  // Only offer sites that belong to the 1P / 2P entities.
  const pickSites = useMemo(() => sites.filter((s) => ['1P', '2P'].includes(siteMeta[s]?.entity)), [sites, siteMeta])

  // 1P/2P sites that don't yet have an AED — used by the auto-generate action.
  const missingSites = useMemo(() => {
    const have = new Set(aeds.map((a) => a.centerName))
    return pickSites.filter((s) => !have.has(s))
  }, [pickSites, aeds])

  // AEDs came from a system with free-text site names. Linking attaches each to
  // the site registry, takes its entity from there, and adopts the registry's
  // wording so the same building is not called two things across modules.
  const orgSites = useAccessibleSites()
  const linkPlan = useMemo(
    () => (orgSites.length ? planSiteLinks(aeds, orgSites) : null),
    [aeds, orgSites]
  )

  const doLinkSites = async () => {
    if (!linkPlan?.linked.length) return
    setBusy(true)
    try {
      const r = await linkAedsToSites(orgName, linkPlan, { uid: profile?.uid, name: profile?.name })
      toast.success(`${r.linked} linked · ${r.nameChanges} renamed · ${r.entityChanges} entity value(s) corrected`)
      setLinkOpen(false)
    } catch (e) {
      toastCaught(e, 'Could not link to sites')
    } finally { setBusy(false) }
  }

  // Open the Add form with an asset ID RESERVED, not guessed.
  //
  // It used to be the highest number in the loaded list plus one, so two people
  // opening this at the same moment both got AED-0042 — and that number is what
  // gets printed on the QR label. A reserved number is consumed even if the form
  // is cancelled, which is the trade reserve.js already makes everywhere else: a
  // gap in a sequence is harmless, two labels reading the same is not.
  const openAdd = async () => {
    try {
      const [assetId] = await reserveAssetIds('aed', 'AED', {
        floor: highestAssetSeq('AED', aeds, 'assetId'),
      })
      setEditing({ ...EMPTY, assetId })
    } catch (e) {
      toastCaught(e, 'Could not reserve an asset ID')
    }
  }

  // One-click (admin): create an AED (with QR code) for every 1P/2P site missing one.
  const generateAll = async () => {
    if (!missingSites.length) return
    if (!window.confirm(`Generate an AED with a QR code for ${missingSites.length} site(s)? You can add battery/pad expiry dates afterwards.`)) return
    setBusy(true)
    try {
      // The whole block reserved at once, so another operator adding a unit
      // mid-batch cannot land inside it.
      const ids = await reserveAssetIds('aed', 'AED', {
        count: missingSites.length,
        floor: highestAssetSeq('AED', aeds, 'assetId'),
      })
      const rows = missingSites.map((s, i) => ({ assetId: ids[i], centerName: s, region: siteMeta[s]?.region || '', entity: siteMeta[s]?.entity || '', status: AED_STATUS.READY }))
      const res = await bulkAddAeds(orgName, rows, { uid: profile?.uid, name: profile?.name })
      toast.success(`Generated ${res.created} AED(s) with QR codes`)
    } catch (e) { toastCaught(e) } finally { setBusy(false) }
  }

  const toggle = (field, v) => setF((p) => ({ ...p, [field]: p[field].includes(v) ? p[field].filter((x) => x !== v) : [...p[field], v] }))
  const anyActive = f.search || f.regions.length || f.entities.length || f.statuses.length
  const clear = () => setF({ search: '', regions: [], entities: [], statuses: [] })

  // Counts for the link-state chips, over the whole register rather than the
  // filtered view — a chip that renumbered itself as you filtered would be
  // reporting the filter back to you.
  const linkCounts = useMemo(() => {
    const ids = siteIdSet(orgSites)
    let linked = 0
    for (const a of aeds) if (isLinkedToSite(a, ids)) linked += 1
    return { linked, unlinked: aeds.length - linked }
  }, [aeds, orgSites])

  // The units already attached to a site — the half of the question the link
  // button answers once there is nothing left to propose.
  const linkedRows = useMemo(() => listLinkedAssets(aeds, orgSites), [aeds, orgSites])

  const visible = useMemo(() => {
    const q = f.search.trim().toLowerCase()
    return filterByLinkState(aeds, orgSites, linkState).filter((a) => {
      if (f.regions.length && !f.regions.includes(a.region)) return false
      if (f.entities.length && !f.entities.includes(a.entity)) return false
      if (f.statuses.length && !f.statuses.includes(a.status)) return false
      if (q && !`${a.assetId} ${a.brand} ${a.model} ${a.centerName} ${a.location}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [aeds, f, orgSites, linkState])

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
  const selectedItems = aeds.filter((a) => selected.has(a.id))
  const deletable = selectedItems.filter((a) => canManageAsset(profile, a, { isAdmin, isManager }))
  const confirmBulkDelete = async () => {
    if (!deletable.length) {
      toast.error('None of the selected AEDs are in your sites.')
      setBulkRemoving(false)
      return
    }
    const items = deletable.map((a) => ({ id: a.id, qrToken: a.qrToken }))
    setBusy(true)
    try {
      await bulkDeleteAeds(items, { uid: profile?.uid, name: profile?.name })
      const skipped = selectedItems.length - deletable.length
      toast.success(
        skipped
          ? `Moved ${items.length} to Recently deleted. ${skipped} ${skipped === 1 ? 'is' : 'are'} outside your sites.`
          : `Moved ${items.length} to Recently deleted`,
      )
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
      if (editing.id) { await updateAed(orgName, editing.id, editing, actor); toast.success('AED updated') }
      else { await addAed(orgName, editing, actor); toast.success('AED added') }
      setEditing(null)
    } catch (err) { toastCaught(err) } finally { setBusy(false) }
  }
  const confirmDelete = async () => {
    try {
      await deleteAed(removing.id, removing.qrToken, { uid: profile?.uid, name: profile?.name }, `${removing.assetId || 'AED'} @ ${removing.centerName}`)
      toast.success('Moved to Recently deleted')
    } catch (err) { toastCaught(err) } finally { setRemoving(null) }
  }
  // View the QR — or, for admins, mint one first if the record lacks it.
  const showQr = async (a) => {
    if (a.qrToken) { setQrFor(a); return }
    if (!isAdmin) { toast.error('Only an admin can generate QR codes'); return }
    setBusy(true)
    try {
      const token = await generateAedQr(orgName, a, { uid: profile?.uid, name: profile?.name })
      setQrFor({ ...a, qrToken: token })
      toast.success('QR code generated')
    } catch (e) { toastCaught(e) } finally { setBusy(false) }
  }
  const openService = (a) => { setServiceFor(a); setNextDate(a.nextInspection || '') }
  const confirmService = async () => {
    setBusy(true)
    try {
      await serviceAed(orgName, serviceFor, nextDate, { uid: profile?.uid, name: profile?.name })
      toast.success('Inspection logged')
      setServiceFor(null)
    } catch (err) { toastCaught(err) } finally { setBusy(false) }
  }
  const doExport = () => {
    if (!visible.length) return toast.error('Nothing to export')
    exportRows(visible.map((a) => ({
      'Asset ID': a.assetId, Brand: a.brand, Model: a.model, Site: a.centerName, Region: a.region,
      Entity: a.entity, Location: a.location, Status: AED_STATUS_LABEL[a.status] || a.status,
      'Install Date': a.installDate, 'Battery Expiry': a.batteryExpiry, 'Pad Expiry': a.padExpiry,
      'Last Inspection': a.lastInspection, 'Next Inspection': a.nextInspection, Notes: a.notes,
    })), 'AED', 'fire-marshal-aed.xlsx')
    toast.success('Exported to Excel')
  }
  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.value })

  return (
    <div>
      <PageHeader title="AED Repository" subtitle={`${visible.length}${anyActive ? ` of ${aeds.length}` : ''} defibrillator${visible.length === 1 ? '' : 's'}`} icon={HeartPulse}>
        {isAdmin && missingSites.length > 0 && (
          <button className="btn-soft" onClick={generateAll} disabled={busy} title="Create an AED with a QR code for every 1P/2P site that doesn't have one">
            <QrCode size={16} /> Generate for 1P/2P sites ({missingSites.length})
          </button>
        )}
        {isAdmin && (
          <button
            className={linkPlan?.linked.length ? 'btn-soft !bg-brand-100 !text-brand-800' : 'btn-soft'}
            onClick={() => { setLinkTab(linkPlan?.linked.length ? 'pending' : 'linked'); setLinkOpen(true) }}
            disabled={busy}
            title="Which AEDs are attached to a site, and which can still be matched to one"
          >
            <MapPin size={16} />
            {linkPlan?.linked.length ? `Link ${linkPlan.linked.length} to sites` : `Site links (${linkedRows.length})`}
          </button>
        )}
        {isAdmin && <Link to="/equipment/asset-bulk-upload" state={{ kind: 'aed' }} className="btn-soft"><Upload size={16} /> Bulk upload</Link>}
        <button className="btn-soft" onClick={doExport} disabled={!aeds.length}><Download size={16} /> Export</button>
        <ExportQrButton kind="aed" rows={selectedItems.length ? selectedItems : visible} selectedCount={selectedItems.length} />
        <RecentlyDeletedLink kinds={['aed']} noun="AEDs" />
        <button className="btn-primary" onClick={openAdd}><Plus size={16} /> Add AED</button>
      </PageHeader>

      {!loading && aeds.length > 0 && (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400"><Filter size={13} /> Filters</span>
            <div className="relative min-w-[200px] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input className="input pl-9" placeholder="Search asset ID, brand, site…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
            </div>
            {anyActive ? <button className="btn-ghost" onClick={clear}><X size={15} /> Clear</button> : null}
          </div>
          <ChipRow label="Region" options={REGIONS} selected={f.regions} onToggle={(v) => toggle('regions', v)} />
          <ChipRow label="Entity" options={ENTITIES} selected={f.entities} onToggle={(v) => toggle('entities', v)} />
          <ChipRow label="Status" options={STATUSES} selected={f.statuses} onToggle={(v) => toggle('statuses', v)} render={(s) => AED_STATUS_LABEL[s]} />
          {linkCounts.linked > 0 && linkCounts.unlinked > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-ink-400">Site link</span>
              <LinkStateChips
                value={linkState}
                onChange={setLinkState}
                linkedCount={linkCounts.linked}
                unlinkedCount={linkCounts.unlinked}
              />
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="grid place-items-center py-20"><Spinner size={28} /></div>
      ) : aeds.length === 0 ? (
        <EmptyState icon={HeartPulse} title="No AEDs yet" hint="Add your first defibrillator to start tracking battery, pad and inspection due dates."
          action={<button className="btn-primary" onClick={openAdd}><Plus size={16} /> Add AED</button>} />
      ) : visible.length === 0 ? (
        <EmptyState icon={Filter} title="No matches" hint="Try adjusting the filters." action={<button className="btn-ghost" onClick={clear}><X size={15} /> Clear filters</button>} />
      ) : (
        <>
          {selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-50 px-4 py-2.5 text-sm">
              <span className="font-semibold text-brand-700">{selected.size} selected</span>
              <div className="flex gap-2">
                <button className="btn-ghost px-3 py-1.5" onClick={() => setSelected(new Set())}>Clear</button>
                {isManager && (
                  <button className="btn-danger px-3 py-1.5" onClick={() => setBulkRemoving(true)}><Trash2 size={15} /> Delete selected</button>
                )}
              </div>
            </div>
          )}
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-surface-100/70 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3"><input type="checkbox" className="h-4 w-4 cursor-pointer accent-brand-500" checked={allOnPage} onChange={toggleAllOnPage} aria-label="Select all AEDs on this page" title="Select all on this page" /></th>
                  <th className="px-4 py-3">Asset ID</th><th className="px-4 py-3">Site</th><th className="px-4 py-3">Region</th>
                  <th className="px-4 py-3">Battery Exp</th><th className="px-4 py-3">Pad Exp</th><th className="px-4 py-3">Next Inspection</th>
                  <th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((a) => (
                  <tr key={a.id} className={`hover:bg-ink-50/70 ${selected.has(a.id) ? 'bg-brand-50/60' : ''}`} style={{ boxShadow: `inset 4px 0 0 ${aedColor(a, today)}` }}>
                    <td className="px-4 py-3"><input type="checkbox" className="h-4 w-4 cursor-pointer accent-brand-500" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} aria-label={`Select ${a.assetId || 'this AED'}`} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 font-bold text-ink-900">
                        {a.assetId || '—'}
                        {aedIncomplete(a) && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Data not available — battery/pad expiry or site still need entering">
                            <AlertTriangle size={11} /> Data N/A
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-500">{[a.brand, a.model].filter(Boolean).join(' ') || '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-ink-700">{a.centerName}{a.location ? <span className="block text-xs text-ink-400">{a.location}</span> : null}</td>
                    <td className="px-4 py-3 text-ink-600">{a.region || '—'}</td>
                    <td className="px-4 py-3"><DateCell value={a.batteryExpiry} /></td>
                    <td className="px-4 py-3"><DateCell value={a.padExpiry} /></td>
                    <td className="px-4 py-3"><DateCell value={a.nextInspection} /></td>
                    <td className="px-4 py-3"><Badge color={AED_STATUS_COLOR[a.status] || '#64748b'}>{AED_STATUS_LABEL[a.status] || a.status}</Badge></td>
                    <td className="px-4 py-3">
                      {/* Every label names the ROW, not just the verb. A screen
                          reader reads these out of the surrounding table, so
                          four rows of "Edit, Delete, Edit, Delete" is a list
                          with no way to tell which AED is about to be removed. */}
                      <div className="flex justify-end gap-1">
                        <IconButton icon={Wrench} iconSize={14} label={`Log inspection / service for ${a.assetId || 'this AED'}`} className="!bg-green-600 !text-white hover:!brightness-110" onClick={() => openService(a)} />
                        <IconButton icon={QrCode} iconSize={15} variant="soft" label={a.qrToken ? `View QR code for ${a.assetId || 'this AED'}` : isAdmin ? `Generate QR code for ${a.assetId || 'this AED'}` : 'Only an admin can generate QR codes'} onClick={() => showQr(a)} disabled={busy || (!a.qrToken && !isAdmin)} />
                        <IconButton icon={Pencil} iconSize={15} variant="soft" label={`Edit ${a.assetId || 'this AED'}`} onClick={() => setEditing(a)} />
                        {isManager && canManageAsset(profile, a, { isAdmin, isManager }) && (
                          <IconButton icon={Trash2} iconSize={15} variant="soft" label={`Delete ${a.assetId || 'this AED'}`} className="!text-red-600" onClick={() => setRemoving(a)} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              className="border-t border-ink-100 px-3 py-2"
              page={page}
              pageCount={pageCount}
              onPage={setPage}
              total={total}
              pageSize={pageSize}
            />
          </div>
        </>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit AED' : 'Add AED'}>
        {editing && (
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Asset ID (auto)"><input className="input bg-ink-50 text-ink-500" value={editing.assetId} readOnly title="Automatically assigned — unique per AED" /></Field>
              <Field label="Site — Region · Entity · Site" className="sm:col-span-2">
                <SiteScopePicker
                  module="equipment"
                  sites={siteInventory}
                  value={{ ...editing, site: editing.centerName }}
                  onChange={(v) => setEditing((p) => ({ ...p, ...v, centerName: v.site }))}
                />
              </Field>
              <Field label="Brand"><input className="input" value={editing.brand} onChange={set('brand')} placeholder="e.g. Philips" /></Field>
              <Field label="Model"><input className="input" value={editing.model} onChange={set('model')} placeholder="e.g. HeartStart FRx" /></Field>
              <Field label="Location / placement"><input className="input" value={editing.location} onChange={set('location')} placeholder="e.g. Reception wall cabinet" /></Field>
              <Field label="Status"><select className="input" value={editing.status} onChange={set('status')}>{STATUSES.map((s) => <option key={s} value={s}>{AED_STATUS_LABEL[s]}</option>)}</select></Field>
              <Field label="Install date"><input type="date" className="input" value={editing.installDate} onChange={set('installDate')} /></Field>
              <Field label="Battery expiry"><input type="date" className="input" value={editing.batteryExpiry} onChange={set('batteryExpiry')} /></Field>
              <Field label="Pad expiry"><input type="date" className="input" value={editing.padExpiry} onChange={set('padExpiry')} /></Field>
              <Field label="Last inspection"><input type="date" className="input" value={editing.lastInspection} onChange={set('lastInspection')} /></Field>
              <Field label="Next inspection"><input type="date" className="input" value={editing.nextInspection} onChange={set('nextInspection')} /></Field>
            </div>
            <Field label="Notes"><textarea className="input" rows={2} value={editing.notes} onChange={set('notes')} /></Field>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? <Spinner size={16} /> : (editing.id ? 'Save changes' : 'Add AED')}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete AED?">
        <p className="text-sm text-ink-600">Move <span className="font-semibold">{removing?.assetId || 'this AED'}</span> at <span className="font-semibold">{removing?.centerName}</span> to Recently deleted? It drops out of lists and QR scans for 30 days. Restoring brings back the same unit and the same QR code.</p>
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
        noun="AED"
        nounPlural="AEDs"
        idLabel="Asset ID"
      />

      <Modal open={bulkRemoving} onClose={() => setBulkRemoving(false)} title={`Delete ${deletable.length} AED(s)?`}>
        <p className="text-sm text-ink-600">
          This moves <span className="font-semibold">{deletable.length}</span> AED{deletable.length === 1 ? '' : 's'} to Recently deleted. They drop out of lists and QR scans for 30 days. Restoring brings back the same unit and the same QR code.
          {selected.size !== deletable.length && (
            <> {selected.size - deletable.length} of the selection {selected.size - deletable.length === 1 ? 'is' : 'are'} outside your sites and will be left in place.</>
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setBulkRemoving(false)}>Cancel</button>
          <button className="btn-danger" onClick={confirmBulkDelete} disabled={busy || !deletable.length}>{busy ? <Spinner size={16} /> : `Delete ${deletable.length}`}</button>
        </div>
      </Modal>

      <Modal open={!!qrFor} onClose={() => setQrFor(null)} title={`QR — ${qrFor?.assetId || 'AED'}`}>
        {qrFor && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="rounded-2xl bg-white p-4 shadow-elev"><QRCodeSVG value={publicQrUrl(qrFor.qrToken)} size={200} level="H" includeMargin /></div>
            <p className="text-sm font-bold text-ink-900">{qrFor.assetId || 'AED'} · {qrFor.centerName}</p>
            <p className="break-all text-xs text-ink-400">{publicQrUrl(qrFor.qrToken)}</p>
            <p className="text-xs text-ink-500">Scanning opens a public status page where anyone can report a defect.</p>
          </div>
        )}
      </Modal>

      <Modal open={!!serviceFor} onClose={() => setServiceFor(null)} title="Log inspection / service">
        {serviceFor && (
          <div className="space-y-4">
            <p className="text-sm text-ink-600">Record an inspection for <strong>{serviceFor.assetId || 'this AED'}</strong> @ <strong>{serviceFor.centerName}</strong>. Last inspection is set to today and status to <strong>Ready</strong>.</p>
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
