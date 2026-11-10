import { useMemo, useState } from 'react'
import { BriefcaseMedical, Plus, Pencil, Trash2, MapPin, X, LayoutGrid, List, Download, Check, Search, Filter, PackageCheck, CalendarX2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Badge, Spinner, Field } from '../components/ui'
import { Pager, IconButton } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { addFirstAid, updateFirstAid, deleteFirstAid, saveFirstAidBox, linkFirstAidToSites } from '../lib/data'
import { planSiteLinks } from '../lib/siteLink'
import { listLinkedAssets, filterByLinkState, siteIdSet, isLinkedToSite } from '../lib/linkedSites'
import LinkSitesModal from '../components/LinkSitesModal'
import LinkStateChips from '../components/LinkStateChips'
import ChipRow from '../components/ChipRow'
import FirstAidBoxModal from '../components/FirstAidBoxModal'
import { exportFirstAid } from '../lib/exporter'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import IncompleteNotice from '../../../shared/ui/IncompleteNotice'
import {
  firstAidCell,
  isItemAvailable,
  siteAttributeMap,
  requiredQty,
  itemExpires,
  isExpired,
  isExpiringSoon,
} from '../lib/firstAidLogic'
import {
  FIRST_AID_ITEM_NAMES,
  FIRST_AID_CONDITIONS,
  FIRST_AID_CONDITION_COLOR,
  REGIONS,
  ENTITIES,
} from '../lib/constants'

// ─────────────────────────────────────────────────────────────────────────────
// First aid boxes, tracked the way signage is: a site × contents matrix rather
// than a list of boxes.
//
// "Does this site have a first aid box" is a question every site answers yes
// to, and it is the question a box-shaped register would ask. The one worth
// asking is which of the contents are in it, in date, and in the quantity it is
// meant to hold — so the unit here is a (site, item) pair, exactly as the
// signage matrix's unit is a (site, sign type) pair.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY = {
  centerName: '',
  region: '',
  entity: '',
  siteId: '',
  site: '',
  item: FIRST_AID_ITEM_NAMES[0],
  boxLocation: '',
  quantity: '',
  condition: 'Available',
  expiryDate: '',
  lastChecked: '',
  notes: '',
}

const EMPTY_FILTERS = { search: '', regions: [], entities: [], items: [], conditions: [] }

export default function FirstAid() {
  const { orgName, profile } = useAuth()
  const {
    firstAid, sites, extinguishers, signages, aeds, fas, stretchers, mockDrills,
    siteInventory, incomplete, loading,
  } = useFleet()

  const [view, setView] = useState('matrix') // 'matrix' | 'list'
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [cellView, setCellView] = useState(null) // { site, item } — matrix cell detail
  const [checking, setChecking] = useState(null) // { site, boxLocation } — box checklist
  const [busy, setBusy] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkTab, setLinkTab] = useState('linked')
  const [linkState, setLinkState] = useState(null)

  const today = useMemo(() => new Date(), [])
  const f = filters
  const anyActive = f.search || f.regions.length || f.entities.length || f.items.length || f.conditions.length
  const toggle = (field, value) =>
    setFilters((prev) => {
      const cur = prev[field]
      return { ...prev, [field]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
    })
  const clearFilters = () => setFilters(EMPTY_FILTERS)

  // Each site's region / entity — the site register first, then every asset
  // register that names a site. The rows here come from the union of all of
  // them, so resolving from a subset would leave a site known only to, say, the
  // stretcher register with no region: still in the totals, gone the instant
  // anybody pressed a region chip. Identical to the signage pages by design.
  const attrSources = useMemo(
    () => [extinguishers, signages, aeds, fas, firstAid, stretchers, mockDrills],
    [extinguishers, signages, aeds, fas, firstAid, stretchers, mockDrills]
  )
  const siteRegion = useMemo(() => siteAttributeMap('region', attrSources, siteInventory), [attrSources, siteInventory])
  const siteEntity = useMemo(() => siteAttributeMap('entity', attrSources, siteInventory), [attrSources, siteInventory])

  // Which contents are shown as matrix columns (all, unless the Item filter narrows them).
  const visibleItems = useMemo(
    () => (f.items.length ? FIRST_AID_ITEM_NAMES.filter((i) => f.items.includes(i)) : FIRST_AID_ITEM_NAMES),
    [f.items]
  )

  // Matrix rows: sites matching Search + Region + Entity (kept even with no
  // records, so a site nobody has surveyed shows its gap rather than vanishing).
  const visibleSites = useMemo(() => {
    const q = f.search.trim().toLowerCase()
    return sites.filter((site) => {
      if (f.regions.length && !f.regions.includes(siteRegion[site])) return false
      if (f.entities.length && !f.entities.includes(siteEntity[site])) return false
      if (q) {
        const siteHit = site.toLowerCase().includes(q)
        const recHit = firstAid.some((r) => r.centerName === site && `${r.item} ${r.boxLocation}`.toLowerCase().includes(q))
        if (!siteHit && !recHit) return false
      }
      return true
    })
  }, [sites, firstAid, f.regions, f.entities, f.search, siteRegion, siteEntity])

  // Matrix and list page separately — one page number would blank whichever
  // view you are not paging. Both page the RENDERED rows only; the export below
  // still walks the whole of visibleSites / filtered.
  const matrixPager = usePagination(visibleSites)

  const linkPlan = useMemo(
    () => (siteInventory.length ? planSiteLinks(firstAid, siteInventory) : null),
    [firstAid, siteInventory]
  )
  const linkedRows = useMemo(() => listLinkedAssets(firstAid, siteInventory), [firstAid, siteInventory])
  // Counts over the whole register, not the filtered view — a chip that
  // renumbered itself as you filtered would be reporting the filter back to you.
  const linkCounts = useMemo(() => {
    const ids = siteIdSet(siteInventory)
    let linked = 0
    for (const r of firstAid) if (isLinkedToSite(r, ids)) linked += 1
    return { linked, unlinked: firstAid.length - linked }
  }, [firstAid, siteInventory])

  const doLinkSites = async () => {
    if (!linkPlan?.linked.length) return
    setBusy(true)
    try {
      const r = await linkFirstAidToSites(orgName || '', linkPlan, { uid: profile?.uid, name: profile?.name })
      toast.success(`${r.linked} linked · ${r.nameChanges} renamed · ${r.entityChanges} entity value(s) corrected`)
      setLinkOpen(false)
    } catch (e) {
      toastCaught(e, 'Could not link to sites')
    } finally { setBusy(false) }
  }

  const filtered = useMemo(() => filterByLinkState(firstAid, siteInventory, linkState).filter((r) => {
    if (f.regions.length && !f.regions.includes(r.region || siteRegion[r.centerName])) return false
    if (f.entities.length && !f.entities.includes(r.entity || siteEntity[r.centerName])) return false
    if (f.items.length && !f.items.includes(r.item)) return false
    if (f.conditions.length && !f.conditions.includes(r.condition)) return false
    if (f.search) {
      const q = f.search.trim().toLowerCase()
      if (!`${r.centerName} ${r.item} ${r.boxLocation}`.toLowerCase().includes(q)) return false
    }
    return true
  }), [firstAid, f.regions, f.entities, f.items, f.conditions, f.search, siteRegion, siteEntity, siteInventory, linkState])
  const listPager = usePagination(filtered)

  // A matrix cell: records for (site, item) that pass the Region / Entity /
  // Condition filters, scored by the shared rule the dashboard also reads.
  const cellFor = (site, item) => {
    let recs = firstAid.filter((r) => r.centerName === site && r.item === item)
    if (f.regions.length) recs = recs.filter((r) => f.regions.includes(r.region || siteRegion[site]))
    if (f.entities.length) recs = recs.filter((r) => f.entities.includes(r.entity || siteEntity[site]))
    if (f.conditions.length) recs = recs.filter((r) => f.conditions.includes(r.condition))
    return firstAidCell(recs, item, today)
  }

  // Group this page's records by site for the list view. Paging counts records
  // rather than sites, so a site with many items continues onto the next page —
  // the count beside a heading is what is listed under it.
  const grouped = useMemo(() => {
    const map = new Map()
    for (const r of listPager.pageItems) {
      const key = r.centerName || 'Unassigned'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(r)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [listPager.pageItems])

  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.value })
  const openAddFor = (centerName, item) => {
    const s = siteInventory.find((x) => x.name === centerName)
    setEditing({
      ...EMPTY,
      item,
      centerName: centerName || '',
      site: s?.name || centerName || '',
      siteId: s?.id || '',
      region: s?.region || '',
      entity: s?.entity || '',
    })
  }

  const save = async (e) => {
    e.preventDefault()
    if (!editing.centerName.trim()) return toast.error('Site is required')
    if (!editing.item) return toast.error('Item is required')
    const qty = Number(editing.quantity)
    if (editing.quantity !== '' && (Number.isNaN(qty) || qty < 0)) return toast.error('Quantity must be 0 or more')
    const payload = { ...editing, quantity: editing.quantity === '' ? 0 : qty }
    if (!itemExpires(payload.item)) payload.expiryDate = ''
    setBusy(true)
    try {
      const actor = { uid: profile?.uid, name: profile?.name }
      if (editing.id) {
        await updateFirstAid(editing.id, payload, actor)
        toast.success('First aid item updated')
      } else {
        await addFirstAid(payload, actor)
        toast.success('First aid item added')
      }
      setEditing(null)
    } catch (err) {
      toastCaught(err)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    try {
      await deleteFirstAid(removing.id, { uid: profile?.uid, name: profile?.name }, `${removing.item} @ ${removing.centerName}`)
      toast.success('Record deleted')
    } catch (err) {
      toastCaught(err)
    } finally {
      setRemoving(null)
    }
  }

  const saveBox = async (rows, removals) => {
    setBusy(true)
    try {
      const s = siteInventory.find((x) => x.name === checking.site)
      const stamped = rows.map((r) => ({
        ...r,
        siteId: s?.id || '',
        siteName: s?.name || r.centerName,
        region: s?.region || siteRegion[r.centerName] || '',
        entity: s?.entity || siteEntity[r.centerName] || '',
      }))
      const res = await saveFirstAidBox(stamped, removals, { uid: profile?.uid, name: profile?.name }, `First aid box @ ${checking.site}`)
      toast.success(`${res.written} item(s) recorded${res.removed ? ` · ${res.removed} removed` : ''}`)
      setChecking(null)
    } catch (err) {
      toastCaught(err)
    } finally { setBusy(false) }
  }

  // ── Export: a matrix sheet (qty / required) + a details sheet — both respect filters ──
  const handleExport = () => {
    const matrixRows = visibleSites.map((site) => {
      const row = { Site: site, Region: siteRegion[site] || '', Entity: siteEntity[site] || '' }
      let available = 0
      for (const item of visibleItems) {
        const c = cellFor(site, item)
        if (isItemAvailable(c)) available++
        row[item] = c.status === 'none' ? '' : c.label
      }
      row.Availability = `${available}/${visibleItems.length}`
      return row
    })
    const detailRows = filtered
      .slice()
      .sort((a, b) => (a.centerName || '').localeCompare(b.centerName || '') || (a.item || '').localeCompare(b.item || ''))
      .map((r) => ({
        Site: r.centerName || '',
        Region: r.region || siteRegion[r.centerName] || '',
        Entity: r.entity || siteEntity[r.centerName] || '',
        Box: r.boxLocation || '',
        Item: r.item || '',
        Quantity: r.quantity ?? 0,
        'Min Required': requiredQty(r.item),
        Condition: r.condition || '',
        Expiry: r.expiryDate || '',
        Expired: isExpired(r, today) ? 'Yes' : 'No',
        'Last Checked': r.lastChecked || '',
        Notes: r.notes || '',
      }))
    if (matrixRows.length === 0) return toast.error('No sites to export')
    exportFirstAid(matrixRows, detailRows, 'ohs-first-aid-boxes.xlsx')
    toast.success('Exported to Excel')
  }

  const cellStyles = {
    none: 'bg-surface-50 text-ink-300',
    ok: 'bg-green-50 text-green-700',
    issue: 'bg-amber-50 text-amber-700',
    missing: 'bg-red-50 text-red-700',
  }

  return (
    <div>
      <PageHeader title="First Aid Boxes" subtitle="Site-wise contents of every first aid box and whether they are actually available" icon={BriefcaseMedical}>
        <div className="flex rounded-xl bg-surface-100 p-1">
          <button onClick={() => setView('matrix')} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${view === 'matrix' ? 'bg-surface text-ink-900 shadow-elev-sm' : 'text-ink-500'}`}><LayoutGrid size={14} /> Matrix</button>
          <button onClick={() => setView('list')} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${view === 'list' ? 'bg-surface text-ink-900 shadow-elev-sm' : 'text-ink-500'}`}><List size={14} /> List</button>
        </div>
        <button
          className={linkPlan?.linked.length ? 'btn-soft !bg-brand-100 !text-brand-800' : 'btn-soft'}
          onClick={() => { setLinkTab(linkPlan?.linked.length ? 'pending' : 'linked'); setLinkOpen(true) }}
          disabled={busy}
          title="Which first aid records are attached to a site, and which can still be matched to one"
        >
          <MapPin size={16} />
          {linkPlan?.linked.length ? `Link ${linkPlan.linked.length} to sites` : `Site links (${linkedRows.length})`}
        </button>
        <button className="btn-soft" onClick={handleExport} disabled={loading || sites.length === 0}><Download size={16} /> Export</button>
        <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16} /> Add item</button>
      </PageHeader>

      <IncompleteNotice incomplete={incomplete} className="mb-4" />

      {!loading && sites.length > 0 && (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400"><Filter size={13} /> Filters</span>
            <div className="relative min-w-[200px] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input className="input pl-9" placeholder="Search site, item or box…" value={f.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
            </div>
            {anyActive ? <button className="btn-ghost" onClick={clearFilters}><X size={15} /> Clear</button> : null}
          </div>
          <ChipRow label="Region" options={REGIONS} selected={f.regions} onToggle={(v) => toggle('regions', v)} />
          <ChipRow label="Entity" options={ENTITIES} selected={f.entities} onToggle={(v) => toggle('entities', v)} />
          <ChipRow label="Item" options={FIRST_AID_ITEM_NAMES} selected={f.items} onToggle={(v) => toggle('items', v)} />
          <ChipRow label="Condition" options={FIRST_AID_CONDITIONS} selected={f.conditions} onToggle={(v) => toggle('conditions', v)} />
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
      ) : sites.length === 0 ? (
        <EmptyState
          icon={BriefcaseMedical}
          title="No sites yet"
          hint="Add a site's first equipment record, then check its first aid box contents here."
          action={<button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16} /> Add item</button>}
        />
      ) : view === 'matrix' ? (
        visibleSites.length === 0 ? (
          <EmptyState icon={Filter} title="No sites match your filters" hint="Try clearing or widening the filters above." action={<button className="btn-ghost" onClick={clearFilters}><X size={15} /> Clear filters</button>} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-ink-500">
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-green-200" /> Stocked</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-amber-200" /> Short, damaged or expiring</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-red-200" /> None usable</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-surface-200" /> Not checked</span>
              <span className="ml-auto text-ink-400">Each cell shows held / required. Click a cell to manage its records, or “Check box” to record the whole box.</span>
            </div>

            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 border-b border-surface-200/60 bg-surface px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-ink-500">Site</th>
                      {visibleItems.map((item) => (
                        <th
                          key={item}
                          title={`${item} — a site is expected to hold at least ${requiredQty(item)}`}
                          className="border-b border-surface-200/60 bg-surface px-2 py-3 text-center text-[10px] font-semibold leading-tight text-ink-500"
                          style={{ minWidth: 78 }}
                        >
                          {item}
                          <span className="block font-normal text-ink-400">min {requiredQty(item)}</span>
                        </th>
                      ))}
                      <th className="border-b border-surface-200/60 bg-surface px-3 py-3 text-center text-[10px] font-bold uppercase tracking-wide text-ink-500" style={{ minWidth: 150 }}>Availability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixPager.pageItems.map((site) => {
                      let available = 0
                      const cells = visibleItems.map((item) => {
                        const c = cellFor(site, item)
                        if (isItemAvailable(c)) available++
                        return { item, ...c }
                      })
                      const pct = Math.round((available / visibleItems.length) * 100)
                      const firstBox = firstAid.find((r) => r.centerName === site && r.boxLocation)?.boxLocation || ''
                      return (
                        <tr key={site} className="group">
                          <td className="sticky left-0 z-10 border-b border-surface-200/40 bg-white px-4 py-2 font-semibold text-ink-800 group-hover:bg-surface-50">
                            <span className="flex items-center gap-1.5"><MapPin size={13} className="text-brand-400" /> {site}</span>
                          </td>
                          {cells.map((c) => (
                            <td key={c.item} className="border-b border-l border-surface-200/40 p-1 text-center">
                              <button
                                onClick={() => (c.count > 0 ? setCellView({ site, item: c.item }) : openAddFor(site, c.item))}
                                title={c.count > 0 ? `${c.qty} of ${c.required} held across ${c.count} record(s)${c.expired ? ` · ${c.expired} expired` : ''} — click to manage` : 'Not checked — click to add'}
                                className={`flex h-9 w-full items-center justify-center gap-1 rounded-lg text-xs font-bold transition hover:ring-2 hover:ring-brand-200 ${cellStyles[c.status]}`}
                              >
                                {c.status === 'none' ? '—' : <span>{c.label}</span>}
                                {c.status === 'ok' && <Check size={12} />}
                                {c.expired > 0 && <CalendarX2 size={12} title={`${c.expired} expired`} />}
                              </button>
                            </td>
                          ))}
                          <td className="flex items-center justify-center gap-2 border-b border-l border-surface-200/40 px-3 py-2 text-center">
                            <span className={`font-bold ${pct >= 80 ? 'text-green-700' : pct >= 40 ? 'text-amber-700' : 'text-red-700'}`}>{available}/{visibleItems.length}</span>
                            <button
                              className="btn-soft !px-2 !py-1 text-[11px]"
                              onClick={() => setChecking({ site, boxLocation: firstBox })}
                              title={`Record the whole first aid box at ${site} in one pass`}
                            >
                              <PackageCheck size={13} /> Check box
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <Pager
                className="border-t border-surface-200/60 px-4 py-3"
                page={matrixPager.page} pageCount={matrixPager.pageCount} onPage={matrixPager.setPage}
                total={matrixPager.total} pageSize={matrixPager.pageSize}
              />
            </div>
          </>
        )
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={BriefcaseMedical}
          title="No first aid records match"
          hint="Adjust the filters above, or record a site's box contents."
          action={<button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16} /> Add item</button>}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(([site, items]) => (
            <div key={site}>
              <div className="mb-2 flex items-center gap-2 px-1">
                <MapPin size={15} className="text-brand-500" />
                <h3 className="text-sm font-extrabold text-ink-800">{site}</h3>
                <span className="chip bg-ink-100 text-ink-500">{items.length}</span>
              </div>
              <div className="card overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-surface-200/60 text-[11px] uppercase tracking-wide text-ink-400">
                    <tr>
                      <th className="px-4 py-2.5">Item</th>
                      <th className="px-4 py-2.5">Box</th>
                      <th className="px-4 py-2.5">Held / min</th>
                      <th className="px-4 py-2.5">Condition</th>
                      <th className="px-4 py-2.5">Expiry</th>
                      <th className="px-4 py-2.5">Last checked</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-200/50">
                    {items.map((r) => {
                      const required = requiredQty(r.item)
                      const short = (Number(r.quantity) || 0) < required
                      const stale = isExpired(r, today)
                      const soon = isExpiringSoon(r, today)
                      return (
                        <tr key={r.id} className="hover:bg-surface-50">
                          <td className="px-4 py-2.5 font-semibold text-ink-800">{r.item}</td>
                          <td className="px-4 py-2.5 text-ink-500">{r.boxLocation || '—'}</td>
                          <td className={`px-4 py-2.5 font-semibold ${short ? 'text-amber-700' : 'text-ink-600'}`}>{r.quantity ?? 0} / {required}</td>
                          <td className="px-4 py-2.5"><Badge color={FIRST_AID_CONDITION_COLOR[r.condition] || '#64748b'}>{r.condition}</Badge></td>
                          <td className={`px-4 py-2.5 ${stale ? 'font-semibold text-red-700' : soon ? 'font-semibold text-amber-700' : 'text-ink-500'}`}>
                            {r.expiryDate || (itemExpires(r.item) ? '—' : 'n/a')}
                          </td>
                          <td className="px-4 py-2.5 text-ink-500">{r.lastChecked || '—'}</td>
                          <td className="px-4 py-2.5">
                            <div className="flex justify-end gap-1">
                              <IconButton icon={Pencil} iconSize={15} variant="soft" label={`Edit ${r.item} at ${r.centerName}`} onClick={() => setEditing({ ...r, quantity: String(r.quantity ?? '') })} />
                              <IconButton icon={Trash2} iconSize={15} variant="soft" className="!text-red-600" label={`Delete ${r.item} at ${r.centerName}`} onClick={() => setRemoving(r)} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <Pager
            className="px-1"
            page={listPager.page} pageCount={listPager.pageCount} onPage={listPager.setPage}
            total={listPager.total} pageSize={listPager.pageSize}
          />
        </div>
      )}

      {/* Add / edit one item */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit first aid item' : 'Add first aid item'}>
        {editing && (
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Site — Region · Entity · Site" className="sm:col-span-2">
                <SiteScopePicker
                  module="equipment"
                  sites={siteInventory}
                  value={editing}
                  onChange={(v) => setEditing((p) => ({ ...p, ...v, centerName: v.site }))}
                />
              </Field>
              <Field label="Item">
                <select className="input" value={editing.item} onChange={set('item')}>
                  {FIRST_AID_ITEM_NAMES.map((i) => <option key={i}>{i}</option>)}
                </select>
              </Field>
              <Field label="Box (optional)">
                <input className="input" placeholder="e.g. Reception, Gym floor" value={editing.boxLocation} onChange={set('boxLocation')} />
              </Field>
              <Field label={`Quantity held (min ${requiredQty(editing.item)})`}>
                <input type="number" min={0} className="input" placeholder="0" value={editing.quantity} onChange={set('quantity')} />
              </Field>
              <Field label="Condition">
                <select className="input" value={editing.condition} onChange={set('condition')}>
                  {FIRST_AID_CONDITIONS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              {itemExpires(editing.item) ? (
                <Field label="Expiry date">
                  <input type="date" className="input" value={editing.expiryDate} onChange={set('expiryDate')} />
                </Field>
              ) : null}
              <Field label="Last checked">
                <input type="date" className="input" value={editing.lastChecked} onChange={set('lastChecked')} />
              </Field>
            </div>
            {itemExpires(editing.item) && !editing.expiryDate && (
              <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
                {editing.item} has a shelf life. Without an expiry date nothing can tell you when it goes out of
                date, and it will keep counting as stock indefinitely.
              </p>
            )}
            <Field label="Notes">
              <textarea className="input" rows={2} value={editing.notes} onChange={set('notes')} />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? <Spinner size={16} /> : (editing.id ? 'Save changes' : 'Add item')}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete first aid record?">
        <p className="text-sm text-ink-600">
          Remove <span className="font-semibold">{removing?.item}</span> at{' '}
          <span className="font-semibold">{removing?.centerName}</span>? This can’t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn-danger" onClick={confirmDelete}>Delete</button>
        </div>
      </Modal>

      {/* Matrix cell — manage this site's records for one item */}
      <Modal open={!!cellView} onClose={() => setCellView(null)} title={cellView ? `${cellView.item} · ${cellView.site}` : ''}>
        {cellView && (() => {
          const recs = firstAid.filter((r) => r.centerName === cellView.site && r.item === cellView.item)
          return (
            <div>
              {recs.length === 0 ? (
                <p className="text-sm text-ink-500">No records left for this item at this site.</p>
              ) : (
                <ul className="space-y-2">
                  {recs.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 rounded-xl border border-surface-200/60 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge color={FIRST_AID_CONDITION_COLOR[r.condition] || '#64748b'}>{r.condition}</Badge>
                          <span className="text-xs text-ink-500">Qty {r.quantity ?? 0} of {requiredQty(r.item)}</span>
                          {isExpired(r, today) && <span className="chip bg-red-100 text-red-700">Expired</span>}
                          {isExpiringSoon(r, today) && <span className="chip bg-amber-100 text-amber-700">Expiring soon</span>}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-ink-500">
                          {r.boxLocation || 'No box recorded'}{r.expiryDate ? ` · expires ${r.expiryDate}` : ''}{r.lastChecked ? ` · checked ${r.lastChecked}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button className="btn-soft px-2 py-1.5" title="Edit" onClick={() => { setEditing({ ...r, quantity: String(r.quantity ?? '') }); setCellView(null) }}><Pencil size={15} /></button>
                        <button className="btn-soft px-2 py-1.5 text-red-600" title="Delete this record" onClick={() => setRemoving(r)}><Trash2 size={15} /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex justify-end gap-2 border-t border-surface-200/60 pt-3">
                <button className="btn-ghost" onClick={() => setCellView(null)}>Close</button>
                <button className="btn-primary" onClick={() => { openAddFor(cellView.site, cellView.item); setCellView(null) }}>
                  <Plus size={16} /> Add another
                </button>
              </div>
            </div>
          )
        })()}
      </Modal>

      <FirstAidBoxModal
        open={!!checking}
        onClose={() => setChecking(null)}
        site={checking?.site}
        boxLocation={checking?.boxLocation}
        records={firstAid}
        onSave={saveBox}
        busy={busy}
      />

      <LinkSitesModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        plan={linkPlan}
        linkedRows={linkedRows}
        initialTab={linkTab}
        onConfirm={doLinkSites}
        busy={busy}
        noun="first aid record"
        nounPlural="first aid records"
        idLabel="Item"
        title="First aid records and their sites"
      />
    </div>
  )
}
