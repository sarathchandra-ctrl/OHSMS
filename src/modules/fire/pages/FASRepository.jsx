import { useMemo, useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BellRing, Plus, Pencil, Trash2, Search, Filter, X, Download, QrCode, Wrench, Upload, AlertTriangle, MapPin } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { format } from 'date-fns'
import { PageHeader, EmptyState, Modal, Badge, Spinner, Field } from '../components/ui'
import { Pager, IconButton } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { canManageAsset } from '../lib/recycle'
import RecentlyDeletedLink from '../components/RecentlyDeletedLink'
import { addFas, updateFas, deleteFas, serviceFas, bulkAddFas, generateFasQr, bulkDeleteFas, linkFasToSites, reserveAssetIds, backfillFasPanelQr } from '../lib/data'
import { isFasControlPanel, planFasPanelQrBackfill } from '../lib/fasQr'
import FasQrCard from '../components/FasQrCard'
import { planSiteLinks } from '../lib/siteLink'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { listLinkedAssets, filterByLinkState, siteIdSet, isLinkedToSite } from '../lib/linkedSites'
import LinkSitesModal from '../components/LinkSitesModal'
import LinkStateChips from '../components/LinkStateChips'
import ExportQrButton from '../components/ExportQrButton'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import { dueState, dueTextColor, fasColor, fasIncomplete, highestAssetSeq } from '../lib/assetLogic'
import { toDate } from '../lib/extinguisherLogic'
import { REGIONS, FAS_DEVICE_TYPES, FAS_STATUS, FAS_STATUS_LABEL, FAS_STATUS_COLOR } from '../lib/constants'

const fmtDate = (v) => { const d = toDate(v); return d ? format(d, 'dd MMM yyyy') : String(v || '') }

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
const EMPTY = {
  deviceId: '', deviceType: 'Control Panel', zone: '', centerName: '', region: '', entity: '', siteId: '', location: '',
  status: FAS_STATUS.OPERATIONAL, installDate: '', lastService: '', nextService: '', amcVendor: '', notes: '',
}
const STATUSES = Object.values(FAS_STATUS)

function ChipRow({ label, options, selected, onToggle, render }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
      <span className="w-16 shrink-0 text-xs font-bold uppercase tracking-wide text-ink-400">{label}</span>
      {options.map((opt) => {
        const on = selected.includes(opt)
        return <button key={opt} type="button" onClick={() => onToggle(opt)} className={`chip transition ${on ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}>{render ? render(opt) : opt}</button>
      })}
    </div>
  )
}
function DateCell({ value }) {
  const s = dueState(value)
  if (!value) return <span className="text-ink-300">—</span>
  const color = dueTextColor(s)
  return <span style={{ color }} className="font-medium">{fmtDate(value)}</span>
}

export default function FASRepository() {
  const { orgName, profile, isAdmin, isManager } = useAuth()
  const { fas, sites, siteInventory, loading, incomplete } = useFleet()
  const navigate = useNavigate()
  const siteMeta = useSiteMeta()
  const today = useMemo(() => new Date(), [])

  const [f, setF] = useState({ search: '', regions: [], types: [], statuses: [] })
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [qrFor, setQrFor] = useState(null)
  const [serviceFor, setServiceFor] = useState(null)
  const [nextDate, setNextDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkTab, setLinkTab] = useState('linked')
  const [linkState, setLinkState] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkRemoving, setBulkRemoving] = useState(false)

  // Only offer sites that belong to the 1P / 2P entities.
  const pickSites = useMemo(() => sites.filter((s) => ['1P', '2P'].includes(siteMeta[s]?.entity)), [sites, siteMeta])

  // 1P/2P sites without a FAS panel yet — used by the auto-generate action.
  const missingSites = useMemo(() => {
    const have = new Set(fas.filter((a) => a.deviceType === 'Control Panel').map((a) => a.centerName))
    return pickSites.filter((s) => !have.has(s))
  }, [pickSites, fas])

  // FAS devices came from a system with free-text site names, exactly as AEDs
  // did. Linking attaches each to the site registry, takes its entity from
  // there, and adopts the registry's wording.
  const orgSites = useAccessibleSites()
  const linkPlan = useMemo(
    () => (orgSites.length ? planSiteLinks(fas, orgSites) : null),
    [fas, orgSites]
  )

  const doLinkSites = async () => {
    if (!linkPlan?.linked.length) return
    setBusy(true)
    try {
      const r = await linkFasToSites(orgName, linkPlan, { uid: profile?.uid, name: profile?.name })
      toast.success(`${r.linked} linked · ${r.nameChanges} renamed · ${r.entityChanges} entity value(s) corrected`)
      setLinkOpen(false)
    } catch (e) {
      toastCaught(e, 'Could not link to sites')
    } finally { setBusy(false) }
  }

  // Open the Add form with a device ID RESERVED, not guessed. See AEDRepository:
  // the highest-in-the-loaded-list arithmetic handed two people the same number,
  // and that number goes on the QR label.
  const openAdd = async () => {
    try {
      const [deviceId] = await reserveAssetIds('fas', 'FAS', {
        floor: highestAssetSeq('FAS', fas, 'deviceId'),
      })
      setEditing({ ...EMPTY, deviceId })
    } catch (e) {
      toastCaught(e, 'Could not reserve a device ID')
    }
  }

  // One-click (admin): create a FAS Panel (with QR code) for every 1P/2P site missing one.
  const generateAll = async () => {
    if (!missingSites.length) return
    if (!window.confirm(`Generate a FAS Panel with a QR code for ${missingSites.length} site(s)?`)) return
    setBusy(true)
    try {
      // The whole block reserved at once, so another operator adding a panel
      // mid-batch cannot land inside it.
      const ids = await reserveAssetIds('fas', 'FAS', {
        count: missingSites.length,
        floor: highestAssetSeq('FAS', fas, 'deviceId'),
      })
      const rows = missingSites.map((s, i) => ({ deviceId: ids[i], centerName: s, region: siteMeta[s]?.region || '', entity: siteMeta[s]?.entity || '', deviceType: 'Control Panel', status: FAS_STATUS.OPERATIONAL }))
      const res = await bulkAddFas(orgName, rows, { uid: profile?.uid, name: profile?.name })
      toast.success(`Generated ${res.created} FAS panel(s) with QR codes`)
    } catch (e) { toastCaught(e) } finally { setBusy(false) }
  }

  const toggle = (field, v) => setF((p) => ({ ...p, [field]: p[field].includes(v) ? p[field].filter((x) => x !== v) : [...p[field], v] }))
  const anyActive = f.search || f.regions.length || f.types.length || f.statuses.length
  const clear = () => setF({ search: '', regions: [], types: [], statuses: [] })

  // Counts for the link-state chips, over the whole register rather than the
  // filtered view — a chip that renumbered itself as you filtered would be
  // reporting the filter back to you.
  const linkCounts = useMemo(() => {
    const ids = siteIdSet(orgSites)
    let linked = 0
    for (const a of fas) if (isLinkedToSite(a, ids)) linked += 1
    return { linked, unlinked: fas.length - linked }
  }, [fas, orgSites])

  // The units already attached to a site — the half of the question the link
  // button answers once there is nothing left to propose.
  const linkedRows = useMemo(() => listLinkedAssets(fas, orgSites), [fas, orgSites])

  const visible = useMemo(() => {
    const q = f.search.trim().toLowerCase()
    return filterByLinkState(fas, orgSites, linkState).filter((a) => {
      if (f.regions.length && !f.regions.includes(a.region)) return false
      if (f.types.length && !f.types.includes(a.deviceType)) return false
      if (f.statuses.length && !f.statuses.includes(a.status)) return false
      if (q && !`${a.deviceId} ${a.deviceType} ${a.zone} ${a.centerName} ${a.location} ${a.amcVendor}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [fas, f, orgSites, linkState])

  // Changing a filter drops the selection — the rows it referred to may no
  // longer be on screen. (The page itself needs no reset; usePagination clamps.)
  useEffect(() => { setSelected(new Set()) }, [f])
  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(visible)

  // Panels added before a QR was assigned on create. The count is what this
  // screen can see; the action itself reads the whole collection, because a
  // capped list drops the oldest rows and those are the ones missing a code.
  const missingPanelQr = useMemo(() => planFasPanelQrBackfill(fas).assign.length, [fas])
  const fasCapped = Boolean(incomplete?.capped?.includes('fas'))

  // ── Row selection + bulk delete ──
  const toggleSel = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const pageIds = pageItems.map((a) => a.id)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const toggleAllOnPage = () => setSelected((prev) => {
    const n = new Set(prev)
    if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id))
    return n
  })
  const selectedItems = fas.filter((a) => selected.has(a.id))
  const deletable = selectedItems.filter((a) => canManageAsset(profile, a, { isAdmin, isManager }))
  const confirmBulkDelete = async () => {
    if (!deletable.length) {
      toast.error('None of the selected devices are in your sites.')
      setBulkRemoving(false)
      return
    }
    const items = deletable.map((a) => ({ id: a.id, qrToken: a.qrToken }))
    setBusy(true)
    try {
      await bulkDeleteFas(items, { uid: profile?.uid, name: profile?.name })
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
      if (editing.id) {
        const hadQr = Boolean(String(editing.qrToken || '').trim())
        const token = await updateFas(orgName, editing.id, editing, actor)
        toast.success(!hadQr && token ? 'FAS device updated — QR code generated' : 'FAS device updated')
      } else {
        const created = await addFas(orgName, editing, actor)
        toast.success(created.qrToken ? 'FAS panel added — QR code ready' : 'FAS device added')
        setEditing(null)
        if (created.qrToken) navigate(`/equipment/fas/${created.id}`)
        return
      }
      setEditing(null)
    } catch (err) { toastCaught(err) } finally { setBusy(false) }
  }
  const confirmDelete = async () => {
    try {
      await deleteFas(removing.id, removing.qrToken, { uid: profile?.uid, name: profile?.name }, `${removing.deviceId || removing.deviceType} @ ${removing.centerName}`)
      toast.success('Moved to Recently deleted')
    } catch (err) { toastCaught(err) } finally { setRemoving(null) }
  }
  // View the QR — or, for admins, mint one first if the record lacks it.
  // QR codes are only generated for Control Panels (the panel represents the
  // whole system); detectors, MCPs and hooters don't get their own QR.
  const showQr = async (a) => {
    if (a.qrToken) { setQrFor(a); return }
    if (!isFasControlPanel(a)) { toast.error('QR codes are only generated for Control Panels'); return }
    if (!isAdmin) { toast.error('Only an admin can generate QR codes'); return }
    setBusy(true)
    try {
      const token = await generateFasQr(orgName, a, { uid: profile?.uid, name: profile?.name })
      setQrFor({ ...a, qrToken: token })
      toast.success('QR code generated')
    } catch (e) { toastCaught(e) } finally { setBusy(false) }
  }
  const openService = (a) => { setServiceFor(a); setNextDate(a.nextService || '') }
  const confirmService = async () => {
    setBusy(true)
    try {
      await serviceFas(orgName, serviceFor, nextDate, { uid: profile?.uid, name: profile?.name })
      toast.success('Service logged')
      setServiceFor(null)
    } catch (err) { toastCaught(err) } finally { setBusy(false) }
  }
  const doExport = async () => {
    if (exporting) return
    if (!visible.length) return toast.error('Nothing to export')
    setExporting(true)
    try {
      const { exportRows } = await import('../lib/exporter')
      exportRows(visible.map((a) => ({
        'Device ID': a.deviceId, Type: a.deviceType, Zone: a.zone, Site: a.centerName, Region: a.region, Entity: a.entity,
        Location: a.location, Status: FAS_STATUS_LABEL[a.status] || a.status, 'Install Date': a.installDate,
        'Last Service': a.lastService, 'Next Service': a.nextService, 'AMC Vendor': a.amcVendor, Notes: a.notes,
      })), 'FAS', 'fire-marshal-fas.xlsx')
      toast.success('Exported to Excel')
    } catch (err) {
      toastCaught(err, 'Could not export fire alarm devices')
    } finally {
      setExporting(false)
    }
  }
  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.value })

  const doBackfillQr = async () => {
    setBusy(true)
    try {
      const r = await backfillFasPanelQr(orgName, { uid: profile?.uid, name: profile?.name })
      toast.success(
        r.assigned
          ? `QR codes generated for ${r.assigned} control panel${r.assigned === 1 ? '' : 's'}`
          : 'Every control panel already has a QR code',
      )
    } catch (e) {
      toastCaught(e, 'Could not generate QR codes')
    } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader title="FAS Repository" subtitle={`${visible.length}${anyActive ? ` of ${fas.length}` : ''} fire-alarm device${visible.length === 1 ? '' : 's'}`} icon={BellRing}>
        {isAdmin && missingSites.length > 0 && (
          <button className="btn-soft" onClick={generateAll} disabled={busy} title="Create a FAS Panel with a QR code for every 1P/2P site that doesn't have one">
            <QrCode size={16} /> Generate panels for 1P/2P sites ({missingSites.length})
          </button>
        )}
        {isAdmin && (
          <button
            className={linkPlan?.linked.length ? 'btn-soft !bg-brand-100 !text-brand-800' : 'btn-soft'}
            onClick={() => { setLinkTab(linkPlan?.linked.length ? 'pending' : 'linked'); setLinkOpen(true) }}
            disabled={busy}
            title="Which devices are attached to a site, and which can still be matched to one"
          >
            <MapPin size={16} />
            {linkPlan?.linked.length ? `Link ${linkPlan.linked.length} to sites` : `Site links (${linkedRows.length})`}
          </button>
        )}
        {isAdmin && (missingPanelQr > 0 || fasCapped) && (
          <button
            className="btn-soft !bg-amber-100 !text-amber-900"
            onClick={doBackfillQr}
            disabled={busy}
            title="Control panels with no QR code cannot be printed or scanned. Codes already on a panel are left as they are."
          >
            <QrCode size={16} /> {missingPanelQr > 0 ? `Generate ${missingPanelQr}${fasCapped ? '+' : ''} missing panel QR` : 'Generate missing panel QR codes'}
          </button>
        )}
        {isAdmin && <Link to="/equipment/asset-bulk-upload" state={{ kind: 'fas' }} className="btn-soft"><Upload size={16} /> Bulk upload</Link>}
        <button className="btn-soft" onClick={doExport} disabled={exporting || !fas.length} aria-busy={exporting}><Download size={16} /> {exporting ? 'Exporting…' : 'Export'}</button>
        <ExportQrButton kind="fas" rows={selectedItems.length ? selectedItems : visible} selectedCount={selectedItems.length} />
        <RecentlyDeletedLink kinds={['fas']} noun="fire alarm devices" />
        <button className="btn-primary" onClick={openAdd}><Plus size={16} /> Add device</button>
      </PageHeader>

      {!loading && fas.length > 0 && (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400"><Filter size={13} /> Filters</span>
            <div className="relative min-w-[200px] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input className="input pl-9" placeholder="Search device ID, type, zone, vendor…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
            </div>
            {anyActive ? <button className="btn-ghost" onClick={clear}><X size={15} /> Clear</button> : null}
          </div>
          <ChipRow label="Region" options={REGIONS} selected={f.regions} onToggle={(v) => toggle('regions', v)} />
          <ChipRow label="Type" options={FAS_DEVICE_TYPES} selected={f.types} onToggle={(v) => toggle('types', v)} />
          <ChipRow label="Status" options={STATUSES} selected={f.statuses} onToggle={(v) => toggle('statuses', v)} render={(s) => FAS_STATUS_LABEL[s]} />
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
      ) : fas.length === 0 ? (
        <EmptyState icon={BellRing} title="No FAS devices yet" hint="Add fire-alarm panels and devices to track service due dates and faults."
          action={<button className="btn-primary" onClick={openAdd}><Plus size={16} /> Add device</button>} />
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
                  <th className="px-4 py-3"><input type="checkbox" className="h-4 w-4 cursor-pointer accent-brand-500" checked={allOnPage} onChange={toggleAllOnPage} aria-label="Select all devices on this page" title="Select all on this page" /></th>
                  <th className="px-4 py-3">Device</th><th className="px-4 py-3">Site</th><th className="px-4 py-3">Zone</th>
                  <th className="px-4 py-3">Next Service</th><th className="px-4 py-3">AMC Vendor</th>
                  <th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((a) => (
                  <tr key={a.id} className={`hover:bg-ink-50/70 ${selected.has(a.id) ? 'bg-brand-50/60' : ''}`} style={{ boxShadow: `inset 4px 0 0 ${fasColor(a, today)}` }}>
                    <td className="px-4 py-3"><input type="checkbox" className="h-4 w-4 cursor-pointer accent-brand-500" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} aria-label={`Select ${a.deviceId || a.deviceType || 'this device'}`} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 font-bold text-ink-900">
                        <Link to={`/equipment/fas/${a.id}`} className="hover:underline">
                          {a.deviceId || a.deviceType}
                        </Link>
                        {fasIncomplete(a) && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Data not available — details still need entering">
                            <AlertTriangle size={11} /> Data N/A
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-500">{a.deviceId ? a.deviceType : (a.location || '—')}</div>
                    </td>
                    <td className="px-4 py-3 text-ink-700">{a.centerName}</td>
                    <td className="px-4 py-3 text-ink-600">{a.zone || '—'}</td>
                    <td className="px-4 py-3"><DateCell value={a.nextService} /></td>
                    <td className="px-4 py-3 text-ink-600">{a.amcVendor || '—'}</td>
                    <td className="px-4 py-3"><Badge color={FAS_STATUS_COLOR[a.status] || '#64748b'}>{FAS_STATUS_LABEL[a.status] || a.status}</Badge></td>
                    <td className="px-4 py-3">
                      {/* Every label names the DEVICE, not just the verb. Read out
                          of the surrounding table by a screen reader, four rows of
                          "Edit, Delete, Edit, Delete" give no way to tell which
                          panel is about to be removed. */}
                      <div className="flex justify-end gap-1">
                        <IconButton icon={Wrench} iconSize={14} label={`Log service for ${a.deviceId || a.deviceType || 'this device'}`} className="!bg-green-600 !text-white hover:!brightness-110" onClick={() => openService(a)} />
                        <IconButton icon={QrCode} iconSize={15} variant="soft" label={a.qrToken ? `View QR code for ${a.deviceId || a.deviceType || 'this device'}` : !isFasControlPanel(a) ? 'QR codes are only for Control Panels' : isAdmin ? `Generate QR code for ${a.deviceId || 'this device'}` : 'Only an admin can generate QR codes'} onClick={() => showQr(a)} disabled={busy || (!a.qrToken && (!isAdmin || !isFasControlPanel(a)))} />
                        <IconButton icon={Pencil} iconSize={15} variant="soft" label={`Edit ${a.deviceId || a.deviceType || 'this device'}`} onClick={() => setEditing(a)} />
                        {isManager && canManageAsset(profile, a, { isAdmin, isManager }) && (
                          <IconButton icon={Trash2} iconSize={15} variant="soft" label={`Delete ${a.deviceId || a.deviceType || 'this device'}`} className="!text-red-600" onClick={() => setRemoving(a)} />
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

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit FAS device' : 'Add FAS device'}>
        {editing && (
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Device ID (auto)"><input className="input bg-ink-50 text-ink-500" value={editing.deviceId} readOnly title="Automatically assigned — unique per device" /></Field>
              <Field label="Device type"><select className="input" value={editing.deviceType} onChange={set('deviceType')}>{FAS_DEVICE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Site — Region · Entity · Site" className="sm:col-span-2">
                <SiteScopePicker
                  module="equipment"
                  sites={siteInventory}
                  value={{ ...editing, site: editing.centerName }}
                  onChange={(v) => setEditing((p) => ({ ...p, ...v, centerName: v.site }))}
                />
              </Field>
              <Field label="Zone / Loop"><input className="input" value={editing.zone} onChange={set('zone')} placeholder="e.g. Zone 4" /></Field>
              <Field label="Location / placement"><input className="input" value={editing.location} onChange={set('location')} placeholder="e.g. 3rd floor lift lobby" /></Field>
              <Field label="Status"><select className="input" value={editing.status} onChange={set('status')}>{STATUSES.map((s) => <option key={s} value={s}>{FAS_STATUS_LABEL[s]}</option>)}</select></Field>
              <Field label="Install date"><input type="date" className="input" value={editing.installDate} onChange={set('installDate')} /></Field>
              <Field label="Last service"><input type="date" className="input" value={editing.lastService} onChange={set('lastService')} /></Field>
              <Field label="Next service"><input type="date" className="input" value={editing.nextService} onChange={set('nextService')} /></Field>
              <Field label="AMC vendor"><input className="input" value={editing.amcVendor} onChange={set('amcVendor')} placeholder="e.g. Acme Fire Systems" /></Field>
            </div>
            <Field label="Notes"><textarea className="input" rows={2} value={editing.notes} onChange={set('notes')} /></Field>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>{busy ? <Spinner size={16} /> : (editing.id ? 'Save changes' : 'Add device')}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete FAS device?">
        <p className="text-sm text-ink-600">Move <span className="font-semibold">{removing?.deviceId || removing?.deviceType}</span> at <span className="font-semibold">{removing?.centerName}</span> to Recently deleted? It drops out of lists and QR scans for 30 days. Restoring brings back the same unit and the same QR code.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn-danger" onClick={confirmDelete}>Delete</button>
        </div>
      </Modal>

      <Modal open={bulkRemoving} onClose={() => setBulkRemoving(false)} title={`Delete ${deletable.length} FAS device(s)?`}>
        <p className="text-sm text-ink-600">
          This moves <span className="font-semibold">{deletable.length}</span> device{deletable.length === 1 ? '' : 's'} to Recently deleted. They drop out of lists and QR scans for 30 days. Restoring brings back the same unit and the same QR code.
          {selected.size !== deletable.length && (
            <> {selected.size - deletable.length} of the selection {selected.size - deletable.length === 1 ? 'is' : 'are'} outside your sites and will be left in place.</>
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setBulkRemoving(false)}>Cancel</button>
          <button className="btn-danger" onClick={confirmBulkDelete} disabled={busy || !deletable.length}>{busy ? <Spinner size={16} /> : `Delete ${deletable.length}`}</button>
        </div>
      </Modal>

      <Modal open={!!qrFor} onClose={() => setQrFor(null)} title={`QR — ${qrFor?.deviceId || qrFor?.deviceType || 'FAS'}`}>
        {qrFor?.qrToken && <FasQrCard panel={qrFor} />}
      </Modal>

      <Modal open={!!serviceFor} onClose={() => setServiceFor(null)} title="Log service">
        {serviceFor && (
          <div className="space-y-4">
            <p className="text-sm text-ink-600">Record a service for <strong>{serviceFor.deviceId || serviceFor.deviceType}</strong> @ <strong>{serviceFor.centerName}</strong>. Last service is set to today and status to <strong>Operational</strong>.</p>
            <Field label="Next service due"><input type="date" className="input" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></Field>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setServiceFor(null)}>Cancel</button>
              <button className="btn-primary" onClick={confirmService} disabled={busy}>{busy ? <Spinner size={16} /> : 'Log service'}</button>
            </div>
          </div>
        )}
      </Modal>
      <LinkSitesModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        plan={linkPlan}
        linkedRows={linkedRows}
        initialTab={linkTab}
        onConfirm={doLinkSites}
        busy={busy}
        noun="FAS device"
        nounPlural="FAS devices"
        idLabel="Device ID"
      />

    </div>
  )
}
