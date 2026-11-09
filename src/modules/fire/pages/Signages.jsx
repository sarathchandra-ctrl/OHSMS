import { useMemo, useState } from 'react'
import { Signpost, Plus, Pencil, Trash2, MapPin, X, LayoutGrid, List, Download, Check, Search, Filter, ImagePlus, Image as ImageIcon, AlertTriangle } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Badge, Spinner, Field } from '../components/ui'
import { Pager, IconButton } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { addSignage, updateSignage, deleteSignage, linkSignagesToSites } from '../lib/firestore'
import { planSiteLinks } from '../lib/siteLink'
import { listLinkedAssets, filterByLinkState, siteIdSet, isLinkedToSite } from '../lib/linkedSites'
import LinkSitesModal from '../components/LinkSitesModal'
import LinkStateChips from '../components/LinkStateChips'
import ChipRow from '../components/ChipRow'
import { exportSignage } from '../lib/exporter'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import IncompleteNotice from '../../../shared/ui/IncompleteNotice'
import { StoredImage } from '../../../shared/storage/StoredImage'
import { safeSrc } from '../../../shared/safeUrl'
import { MAX_UPLOAD_BYTES, formatSize } from '../../../shared/storage'
import { fileToCompressedDataUrl } from '../../../shared/lib/image'
import {
  isFerp,
  ferpCovered,
  signageCell,
  isTypeCovered,
  siteAttributeMap,
  extCountBySite,
  EXT_SIGN_TYPE,
  signageStatus,
  isSignageCompliant,
  signagePhotos,
  signagePhotoCount,
  requiredSignagePhotos,
  signagePhotoProgress,
  photoShortfallMessage,
  deployedRequirementErrors,
} from '../lib/signageLogic'
import {
  SIGNAGE_TYPES,
  SIGNAGE_STATUSES,
  SIGNAGE_STATUS_NOT_SET,
  SIGNAGE_STATUS_COLOR,
  SIGNAGE_PHOTO,
  REGIONS,
  ENTITIES,
} from '../lib/constants'

const EMPTY = {
  centerName: '',
  region: '',
  entity: '',
  siteId: '',
  site: '',
  type: 'Stretcher Signage',
  floor: '',
  location: '',
  // '' = Not set. Deployed = compliant, and can only be chosen with the required
  // photos and a last-checked date; every other status is non-compliant.
  status: '',
  quantity: 1,
  lastChecked: '',
  notes: '',
  // The photos: stored pointers, plus freshly picked ones (compressed data: URLs)
  // that are uploaded on save. See resolveSignagePhotos in lib/firestore.js.
  // (A legacy single `photo` on an older record is read as one entry.)
  photos: [],
  // FERP floor coverage
  totalFloors: '',
  allFloors: true,
  floorsCovered: '',
}

/** Compliance follows status: Deployed gets a green tick; anything else is non-compliant and gets none. */
function ComplianceMark({ rec }) {
  return isSignageCompliant(rec) ? (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
      <Check size={14} aria-hidden="true" /> Compliant
    </span>
  ) : (
    <span className="text-xs font-semibold text-red-600">Non-compliant</span>
  )
}

/** 'Photos: 2 / 5' — uploaded vs the count expected for the sign; amber when short. Informational. */
function PhotoCount({ rec }) {
  const { have, need, missing, per } = signagePhotoProgress(rec)
  const short = missing > 0
  return (
    <span
      data-testid="photo-count"
      className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold ${short ? 'text-amber-600' : 'text-ink-500'}`}
      title={short ? `${missing} more expected${per ? ` (one per ${per})` : ''}` : 'Photos uploaded'}
    >
      <ImageIcon size={13} aria-hidden="true" /> Photos: {have} / {need}
    </span>
  )
}

const STATUS_FILTER_OPTIONS = [...SIGNAGE_STATUSES, SIGNAGE_STATUS_NOT_SET]
const EMPTY_FILTERS = { search: '', regions: [], entities: [], types: [], statuses: [] }

export default function Signages() {
  const { orgName, profile } = useAuth()
  const { signages, sites, extinguishers, aeds, fas, firstAid, stretchers, mockDrills, siteInventory, incomplete, loading } = useFleet()

  const [view, setView] = useState('matrix') // 'matrix' | 'list'
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [editing, setEditing] = useState(null) // signage object or {…EMPTY}
  const [removing, setRemoving] = useState(null)
  const [cellView, setCellView] = useState(null) // { site, type } — matrix cell detail panel
  const [busy, setBusy] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkTab, setLinkTab] = useState('linked')
  const [linkState, setLinkState] = useState(null)

  const f = filters
  const anyActive = f.search || f.regions.length || f.entities.length || f.types.length || f.statuses.length
  const toggle = (field, value) =>
    setFilters((prev) => {
      const cur = prev[field]
      return { ...prev, [field]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
    })
  const clearFilters = () => setFilters(EMPTY_FILTERS)

  // Each site's region / entity — the site register first, then every asset
  // register that names a site. The matrix rows come from the union of ALL the
  // registers, so resolving from only two left the sites known to the AED or
  // fire-alarm register unfilterable: present in the matrix, gone the moment a
  // region chip was pressed. Kept identical to the dashboard's, which is the
  // point of both reading one helper.
  const attrSources = useMemo(
    () => [extinguishers, signages, aeds, fas, firstAid, stretchers, mockDrills],
    [extinguishers, signages, aeds, fas, firstAid, stretchers, mockDrills]
  )
  const siteRegion = useMemo(
    () => siteAttributeMap('region', attrSources, siteInventory),
    [attrSources, siteInventory]
  )
  const siteEntity = useMemo(
    () => siteAttributeMap('entity', attrSources, siteInventory),
    [attrSources, siteInventory]
  )

  // How many extinguishers each site has (from the Repository) — the target
  // count of "Fire Extinguisher Sign" records for that site.
  const extCounts = useMemo(() => extCountBySite(extinguishers), [extinguishers])

  // Which signage types are shown as matrix columns (all, unless the Type filter narrows them).
  const visibleTypes = useMemo(
    () => (f.types.length ? SIGNAGE_TYPES.filter((t) => f.types.includes(t)) : SIGNAGE_TYPES),
    [f.types]
  )

  // Matrix rows: sites matching the Search + Region filters (kept even with no signage, so gaps show).
  const visibleSites = useMemo(() => {
    const q = f.search.trim().toLowerCase()
    return sites.filter((site) => {
      if (f.regions.length && !f.regions.includes(siteRegion[site])) return false
      if (f.entities.length && !f.entities.includes(siteEntity[site])) return false
      if (q) {
        const siteHit = site.toLowerCase().includes(q)
        const recHit = signages.some((s) => s.centerName === site && `${s.type} ${s.location}`.toLowerCase().includes(q))
        if (!siteHit && !recHit) return false
      }
      return true
    })
  }, [sites, signages, f.regions, f.entities, f.search, siteRegion, siteEntity])

  // The matrix and the list are paged separately — a single page number would
  // blank whichever view you are not paging. Both page the RENDERED rows only:
  // the export below still walks the whole of `visibleSites` / `filtered`.
  const matrixPager = usePagination(visibleSites)

  // List records: every record matching all active filters.
  // Signage arrived from the same free-text world as the other registers, and
  // until now was the only one with nowhere to record the match.
  const linkPlan = useMemo(
    () => (siteInventory.length ? planSiteLinks(signages, siteInventory) : null),
    [signages, siteInventory]
  )
  const linkedRows = useMemo(() => listLinkedAssets(signages, siteInventory), [signages, siteInventory])
  // Counts over the whole register, not the filtered view.
  const linkCounts = useMemo(() => {
    const ids = siteIdSet(siteInventory)
    let linked = 0
    for (const a of signages) if (isLinkedToSite(a, ids)) linked += 1
    return { linked, unlinked: signages.length - linked }
  }, [signages, siteInventory])

  const doLinkSites = async () => {
    if (!linkPlan?.linked.length) return
    setBusy(true)
    try {
      const r = await linkSignagesToSites(orgName || '', linkPlan, { uid: profile?.uid, name: profile?.name })
      toast.success(`${r.linked} linked · ${r.nameChanges} renamed · ${r.entityChanges} entity value(s) corrected`)
      setLinkOpen(false)
    } catch (e) {
      toastCaught(e, 'Could not link to sites')
    } finally { setBusy(false) }
  }

  const filtered = useMemo(() => filterByLinkState(signages, siteInventory, linkState).filter((s) => {
    if (f.regions.length && !f.regions.includes(s.region)) return false
    if (f.entities.length && !f.entities.includes(s.entity || siteEntity[s.centerName])) return false
    if (f.types.length && !f.types.includes(s.type)) return false
    if (f.statuses.length && !f.statuses.includes(signageStatus(s))) return false
    if (f.search) {
      const q = f.search.trim().toLowerCase()
      if (!`${s.centerName} ${s.type} ${s.location}`.toLowerCase().includes(q)) return false
    }
    return true
  }), [signages, f.regions, f.entities, f.types, f.statuses, f.search, siteEntity, siteInventory, linkState])
  const listPager = usePagination(filtered)

  // A matrix cell: records for (site, type) that pass the Region / Entity / Status filters.
  const cellFor = (site, type) => {
    let recs = signages.filter((s) => s.centerName === site && s.type === type)
    if (f.regions.length) recs = recs.filter((r) => f.regions.includes(r.region))
    if (f.entities.length) recs = recs.filter((r) => f.entities.includes(r.entity || siteEntity[site]))
    if (f.statuses.length) recs = recs.filter((r) => f.statuses.includes(signageStatus(r)))

    // Fire-extinguisher signage is scored against the site's extinguisher count;
    // FERP against its floors. Both rules live in lib/signageLogic so the
    // Signage Compliance dashboard scores a site identically.
    return signageCell(recs, type, extCounts[site] || 0)
  }

  // Group this page's records by site for the list view. Paging counts records
  // rather than sites, so a site with many signs continues onto the next page —
  // the count beside a heading is what is listed under it.
  const grouped = useMemo(() => {
    const map = new Map()
    for (const s of listPager.pageItems) {
      const key = s.centerName || 'Unassigned'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [listPager.pageItems])

  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.value })
  const openAddFor = (centerName, type) => {
    // Prefill the correlated picker from the registered site when the group name
    // matches a known site; otherwise keep the (legacy) name as the site value.
    const s = siteInventory.find((x) => x.name === centerName)
    setEditing({
      ...EMPTY,
      type,
      centerName: centerName || '',
      site: s?.name || centerName || '',
      siteId: s?.id || '',
      region: s?.region || '',
      entity: s?.entity || '',
    })
  }

  // The stored record the open form started from (null for a new one). The
  // Deployed requirement applies when status is being SET to Deployed, so it has
  // to know what the record was.
  const editingPrev = editing?.id ? signages.find((s) => s.id === editing.id) || null : null
  const deployedErrors = editing ? deployedRequirementErrors(editing, editingPrev) : {}
  const hasDeployedErrors = Object.keys(deployedErrors).length > 0

  const formPhotos = editing ? signagePhotos(editing) : []
  const required = editing ? requiredSignagePhotos(editing) : { count: 1, per: null }
  // Fewer photos than expected is a warning only — Save is not held for it.
  const photoWarning = editing ? photoShortfallMessage(editing) : ''
  // The photo list lives in `photos`; writing it also retires the legacy `photo`
  // (its pointer is already one of the entries), so it migrates on save.
  const setPhotos = (list) => setEditing((p) => (p ? { ...p, photos: list, photo: null } : p))

  // Read + compress the picked files (one Add can carry several), skipping and
  // reporting any that are not usable rather than failing the whole batch.
  const readPhotos = async (files) => {
    const out = []
    for (const file of files) {
      if (!file.type.startsWith('image/')) { toast.error(`${file.name}: only image files are allowed`); continue }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`${file.name}: too large (${formatSize(file.size)}). Max ${formatSize(MAX_UPLOAD_BYTES)}.`)
        continue
      }
      try {
        // Downscaled + re-encoded in the browser, as LOTO photos are, so what is
        // uploaded is a few hundred KB rather than a full-resolution capture.
        out.push(await fileToCompressedDataUrl(file, SIGNAGE_PHOTO))
      } catch (err) {
        toastCaught(err)
      }
    }
    return out
  }
  const onAddPhotos = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setPhotoBusy(true)
    try {
      const drafts = await readPhotos(files)
      if (drafts.length) setEditing((p) => (p ? { ...p, photos: [...signagePhotos(p), ...drafts], photo: null } : p))
    } finally {
      setPhotoBusy(false)
    }
  }
  const onReplacePhoto = (index) => async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setPhotoBusy(true)
    try {
      const [draft] = await readPhotos([file])
      if (draft) setEditing((p) => {
        if (!p) return p
        const list = signagePhotos(p).slice()
        list[index] = draft
        return { ...p, photos: list, photo: null }
      })
    } finally {
      setPhotoBusy(false)
    }
  }
  const removePhoto = (index) => setPhotos(formPhotos.filter((_, i) => i !== index))

  const save = async (e) => {
    e.preventDefault()
    if (!editing.centerName.trim()) return toast.error('Site is required')
    if (hasDeployedErrors) return toast.error(Object.values(deployedErrors)[0])
    const payload = { ...editing }
    if (isFerp(payload.type)) {
      const total = Number(payload.totalFloors) || 0
      if (total < 1) return toast.error('Enter the number of floors for FERP')
      payload.totalFloors = total
      payload.floorsCovered = payload.allFloors ? total : Math.min(Number(payload.floorsCovered) || 0, total)
    } else {
      payload.totalFloors = 0
      payload.allFloors = false
      payload.floorsCovered = 0
    }
    setBusy(true)
    try {
      const actor = { uid: profile?.uid, name: profile?.name }
      if (editing.id) {
        await updateSignage(editing.id, payload, actor, editingPrev)
        toast.success('Signage updated')
      } else {
        await addSignage(payload, actor)
        toast.success('Signage added')
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
      await deleteSignage(removing.id, { uid: profile?.uid, name: profile?.name }, `${removing.type} @ ${removing.centerName}`, signagePhotos(removing).map((p) => p?.path).filter(Boolean))
      toast.success('Signage deleted')
    } catch (err) {
      toastCaught(err)
    } finally {
      setRemoving(null)
    }
  }

  // ── Export: a matrix sheet (counts) + a details sheet (every record) — both respect filters ──
  const handleExport = () => {
    const matrixRows = visibleSites.map((site) => {
      const row = { Site: site, Region: siteRegion[site] || '', Entity: siteEntity[site] || '' }
      let covered = 0
      for (const t of visibleTypes) {
        const c = cellFor(site, t)
        if (isTypeCovered(t, c)) covered++
        row[t] = t === EXT_SIGN_TYPE && c.label ? c.label : c.count
      }
      row.Coverage = `${covered}/${visibleTypes.length}`
      return row
    })
    const detailRows = filtered
      .slice()
      .sort((a, b) => (a.centerName || '').localeCompare(b.centerName || '') || a.type.localeCompare(b.type))
      .map((s) => ({
        Site: s.centerName || '',
        Region: s.region || '',
        Entity: s.entity || siteEntity[s.centerName] || '',
        Type: s.type,
        Floor: isFerp(s.type) ? (s.totalFloors ? `${ferpCovered(s)}/${s.totalFloors}` : '') : (s.floor || ''),
        Location: s.location || '',
        Status: signageStatus(s),
        Compliant: isSignageCompliant(s) ? 'Yes' : 'No',
        'Required Photos': requiredSignagePhotos(s).count,
        'Uploaded Photos': signagePhotoCount(s),
        Quantity: s.quantity ?? '',
        'Last Checked': s.lastChecked || '',
        Notes: s.notes || '',
      }))
    if (matrixRows.length === 0) return toast.error('No sites to export')
    exportSignage(matrixRows, detailRows, 'fire-marshal-safety-signage.xlsx')
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
      <PageHeader title="Safety Signage" subtitle="Site-wise availability of fire & safety signage" icon={Signpost}>
        <div className="flex rounded-xl bg-surface-100 p-1">
          <button onClick={() => setView('matrix')} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${view === 'matrix' ? 'bg-surface text-ink-900 shadow-elev-sm' : 'text-ink-500'}`}><LayoutGrid size={14} /> Matrix</button>
          <button onClick={() => setView('list')} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${view === 'list' ? 'bg-surface text-ink-900 shadow-elev-sm' : 'text-ink-500'}`}><List size={14} /> List</button>
        </div>
        <button
          className={linkPlan?.linked.length ? 'btn-soft !bg-brand-100 !text-brand-800' : 'btn-soft'}
          onClick={() => { setLinkTab(linkPlan?.linked.length ? 'pending' : 'linked'); setLinkOpen(true) }}
          disabled={busy}
          title="Which signage is attached to a site, and which can still be matched to one"
        >
          <MapPin size={16} />
          {linkPlan?.linked.length ? `Link ${linkPlan.linked.length} to sites` : `Site links (${linkedRows.length})`}
        </button>
        <button className="btn-soft" onClick={handleExport} disabled={loading || sites.length === 0}><Download size={16} /> Export</button>
        <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16} /> Add signage</button>
      </PageHeader>


      <IncompleteNotice incomplete={incomplete} className="mb-4" />
      {/* Filters — same chip style as the Dashboard / Repository */}
      {!loading && sites.length > 0 && (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400"><Filter size={13} /> Filters</span>
            <div className="relative min-w-[200px] flex-1">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
              <input className="input pl-9" placeholder="Search site, type or location…" value={f.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
            </div>
            {anyActive ? <button className="btn-ghost" onClick={clearFilters}><X size={15} /> Clear</button> : null}
          </div>
          <ChipRow label="Region" options={REGIONS} selected={f.regions} onToggle={(v) => toggle('regions', v)} />
          <ChipRow label="Entity" options={ENTITIES} selected={f.entities} onToggle={(v) => toggle('entities', v)} />
          <ChipRow label="Type" options={SIGNAGE_TYPES} selected={f.types} onToggle={(v) => toggle('types', v)} />
          <ChipRow label="Status" options={STATUS_FILTER_OPTIONS} selected={f.statuses} onToggle={(v) => toggle('statuses', v)} />
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
      ) : sites.length === 0 ? (
        <EmptyState
          icon={Signpost}
          title="No sites yet"
          hint="Add a site's first extinguisher or signage record, then track signage availability here."
          action={<button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16} /> Add signage</button>}
        />
      ) : view === 'matrix' ? (
        visibleSites.length === 0 ? (
          <EmptyState icon={Filter} title="No sites match your filters" hint="Try clearing or widening the filters above." action={<button className="btn-ghost" onClick={clearFilters}><X size={15} /> Clear filters</button>} />
        ) : (
        <>
          {/* Legend */}
          <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-ink-500">
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-green-200" /> Deployed — compliant ✓</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-amber-200" /> Partly deployed</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-red-200" /> Not deployed — non-compliant</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-surface-200" /> Not recorded</span>
            <span className="ml-auto text-ink-400">🧯 column shows signs / extinguishers — they should match. Click a cell to manage records.</span>
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 border-b border-surface-200/60 bg-surface px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-ink-500">Site</th>
                    {visibleTypes.map((t) => (
                      <th
                        key={t}
                        title={t === EXT_SIGN_TYPE ? 'Recorded signs / fire extinguishers at the site — these should match' : undefined}
                        className="border-b border-surface-200/60 bg-surface px-2 py-3 text-center text-[10px] font-semibold leading-tight text-ink-500"
                        style={{ minWidth: 78 }}
                      >
                        {t}{t === EXT_SIGN_TYPE ? ' 🧯' : ''}
                      </th>
                    ))}
                    <th className="border-b border-surface-200/60 bg-surface px-3 py-3 text-center text-[10px] font-bold uppercase tracking-wide text-ink-500" style={{ minWidth: 78 }}>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {matrixPager.pageItems.map((site) => {
                    let covered = 0
                    const cells = visibleTypes.map((t) => {
                      const c = cellFor(site, t)
                      if (isTypeCovered(t, c)) covered++
                      return { t, ...c }
                    })
                    const pct = Math.round((covered / visibleTypes.length) * 100)
                    return (
                      <tr key={site} className="group">
                        <td className="sticky left-0 z-10 border-b border-surface-200/40 bg-white px-4 py-2 font-semibold text-ink-800 group-hover:bg-surface-50">
                          <span className="flex items-center gap-1.5"><MapPin size={13} className="text-brand-400" /> {site}</span>
                        </td>
                        {cells.map((c) => (
                          <td key={c.t} className="border-b border-l border-surface-200/40 p-1 text-center">
                            <button
                              onClick={() => (c.count > 0 ? setCellView({ site, type: c.t }) : openAddFor(site, c.t))}
                              title={c.count > 0 ? `${c.count} record(s) — click to manage` : 'Not recorded — click to add'}
                              className={`flex h-9 w-full items-center justify-center gap-1 rounded-lg text-xs font-bold transition hover:ring-2 hover:ring-brand-200 ${cellStyles[c.status]}`}
                            >
                              {c.status === 'none' ? '—' : c.label ? <span>{c.label}</span> : c.status === 'missing' ? <X size={14} /> : c.status === 'issue' ? <AlertTriangle size={14} aria-label="Partly deployed" /> : <Check size={14} aria-label="Compliant" />}
                              {!c.label && c.count > 1 && <span>{c.count}</span>}
                              {c.label && c.status === 'ok' && <Check size={13} aria-label="Compliant" />}
                            </button>
                          </td>
                        ))}
                        <td className="border-b border-l border-surface-200/40 px-3 py-2 text-center">
                          <span className={`font-bold ${pct >= 80 ? 'text-green-700' : pct >= 40 ? 'text-amber-700' : 'text-red-700'}`}>{covered}/{visibleTypes.length}</span>
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
          icon={Signpost}
          title="No signage matches"
          hint="Adjust the filters above, or add fire-safety signs for your sites."
          action={<button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16} /> Add signage</button>}
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
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Floor</th>
                      <th className="px-4 py-2.5">Location</th>
                      <th className="px-4 py-2.5">Qty</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Compliant</th>
                      <th className="px-4 py-2.5">Photos</th>
                      <th className="px-4 py-2.5">Last checked</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-200/50">
                    {items.map((s) => (
                      <tr key={s.id} className="hover:bg-surface-50">
                        <td className="px-4 py-2.5 font-semibold text-ink-800">
                          {s.type}
                          {signagePhotoCount(s) > 0 && <ImageIcon size={13} className="ml-1.5 inline text-ink-400" aria-label={`${signagePhotoCount(s)} photo(s) attached`} />}
                        </td>
                        <td className="px-4 py-2.5 text-ink-500">{isFerp(s.type) ? (s.totalFloors ? `${ferpCovered(s)}/${s.totalFloors} floors` : '—') : (s.floor || '—')}</td>
                        <td className="px-4 py-2.5 text-ink-500">{s.location || '—'}</td>
                        <td className="px-4 py-2.5 text-ink-600">{s.quantity}</td>
                        <td className="px-4 py-2.5">
                          <Badge color={SIGNAGE_STATUS_COLOR[signageStatus(s)]}>{signageStatus(s)}</Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <ComplianceMark rec={s} />
                        </td>
                        <td className="px-4 py-2.5"><PhotoCount rec={s} /></td>
                        <td className="px-4 py-2.5 text-ink-500">{s.lastChecked || '—'}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex justify-end gap-1">
                            <IconButton icon={Pencil} iconSize={15} variant="soft" label={`Edit ${s.type} signage${s.location ? ` at ${s.location}` : ''}`} onClick={() => setEditing(s)} />
                            <IconButton icon={Trash2} iconSize={15} variant="soft" className="!text-red-600" label={`Delete ${s.type} signage${s.location ? ` at ${s.location}` : ''}`} onClick={() => setRemoving(s)} />
                          </div>
                        </td>
                      </tr>
                    ))}
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

      {/* Add / edit modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit signage' : 'Add signage'}>
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
              <Field label="Signage type">
                <select className="input" value={editing.type} onChange={set('type')}>
                  {SIGNAGE_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              {isFerp(editing.type) ? (
                <Field label="Number of floors">
                  <input type="number" min={1} className="input" placeholder="e.g. 8" value={editing.totalFloors} onChange={set('totalFloors')} />
                </Field>
              ) : (
                <Field label="Floor (optional)">
                  <input className="input" placeholder="e.g. Ground, 1, 2, Basement" value={editing.floor} onChange={set('floor')} />
                </Field>
              )}
              <Field label="Status">
                <select className="input" value={editing.status || ''} onChange={set('status')}>
                  <option value="">{SIGNAGE_STATUS_NOT_SET}</option>
                  {SIGNAGE_STATUSES.map((st) => <option key={st}>{st}</option>)}
                </select>
              </Field>
              <Field label="Location / placement">
                <input className="input" placeholder="e.g. Above stairwell C door" value={editing.location} onChange={set('location')} />
              </Field>
              <Field label="Quantity">
                <input type="number" min={1} className="input" value={editing.quantity} onChange={set('quantity')} />
              </Field>
              <Field label="Last checked" error={deployedErrors.lastChecked}>
                <input type="date" className="input" value={editing.lastChecked} onChange={set('lastChecked')} />
              </Field>
              <div className="sm:col-span-2" data-testid="signage-photo">
                <p className="label">Photos</p>
                <p className="mb-2 text-xs text-ink-500" data-testid="photo-counter">
                  {formPhotos.length} of {required.count} photo{required.count === 1 ? '' : 's'} added
                  {required.per ? ` (one per ${required.per})` : ''}
                  {editing.status !== 'Deployed' ? ' — at least 1 is needed to mark as Deployed' : ''}
                </p>
                {photoWarning && (
                  <p role="status" data-testid="photo-warning" className="mb-2 flex items-start gap-1.5 text-xs font-medium text-amber-600">
                    <AlertTriangle size={13} className="mt-px shrink-0" /> {photoWarning}
                  </p>
                )}
                {formPhotos.length > 0 && (
                  <ul className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {formPhotos.map((ph, i) => (
                      <li key={typeof ph === 'string' ? `d${i}` : (ph.path || ph.url || `p${i}`)} className="space-y-1.5" data-testid="signage-photo-item">
                        <div className="aspect-square overflow-hidden rounded-lg border border-surface-200">
                          {typeof ph === 'string' ? (
                            <img src={safeSrc(ph)} alt={`Signage ${i + 1}`} className="h-full w-full object-cover" />
                          ) : (
                            <StoredImage
                              pointer={ph}
                             
                              alt={`Signage ${i + 1}`}
                              className="h-full w-full object-cover"
                              fallback={<span className="grid h-full w-full place-items-center text-ink-300"><ImageIcon size={20} /></span>}
                            />
                          )}
                        </div>
                        <div className="flex gap-1">
                          <label className="btn-soft flex-1 cursor-pointer justify-center !px-2 !py-1 text-xs" aria-label={`Replace photo ${i + 1}`}>
                            <ImagePlus size={13} /> Replace
                            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onReplacePhoto(i)} disabled={photoBusy} />
                          </label>
                          <button type="button" className="btn-ghost !px-2 !py-1 text-xs !text-red-600" aria-label={`Remove photo ${i + 1}`} onClick={() => removePhoto(i)}>
                            <Trash2 size={13} /> Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <label className="btn-soft cursor-pointer">
                  {photoBusy ? <Spinner size={16} /> : <ImagePlus size={16} />}
                  {formPhotos.length ? 'Add more photos' : 'Add photos'}
                  <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={onAddPhotos} disabled={photoBusy} />
                </label>
                {deployedErrors.photo && (
                  <p role="alert" className="mt-1 text-xs font-medium text-red-400">{deployedErrors.photo}</p>
                )}
              </div>
            </div>
            {isFerp(editing.type) && (
              <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50/60 p-3 ">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink-700">
                  <input type="checkbox" checked={!!editing.allFloors} onChange={(e) => setEditing({ ...editing, allFloors: e.target.checked })} />
                  FERP available on all floors
                </label>
                {!editing.allFloors && (
                  <Field label="Floors with FERP available" className="mt-2 max-w-[240px]">
                    <input type="number" min={0} max={editing.totalFloors || undefined} className="input" placeholder="e.g. 6" value={editing.floorsCovered} onChange={set('floorsCovered')} />
                  </Field>
                )}
                <p className="mt-2 text-xs text-ink-400">A Fire Emergency Response Plan should be displayed on every floor.</p>
              </div>
            )}
            {editing.type === EXT_SIGN_TYPE && editing.centerName.trim() && (() => {
              const site = editing.centerName.trim()
              const required = extCounts[site] || 0
              const others = signages
                .filter((s) => s.centerName === site && s.type === EXT_SIGN_TYPE && isSignageCompliant(s) && s.id !== editing.id)
                .reduce((a, s) => a + (Number(s.quantity) || 1), 0)
              const withThis = others + (editing.status === 'Deployed' ? Number(editing.quantity) || 0 : 0)
              return (
                <div className="rounded-xl bg-brand-50 p-3 text-xs text-ink-600">
                  🧯 <strong>{site}</strong> has <strong>{required}</strong> fire extinguisher(s) in the Repository.
                  {required > 0 ? (
                    <> With this record you’ll have <strong>{withThis}</strong> deployed sign(s) here — {withThis >= required ? 'that matches the fleet ✅' : `${required - withThis} more needed to match.`}</>
                  ) : (
                    <> Add extinguishers to the Repository to track sign coverage.</>
                  )}
                </div>
              )
            })()}
            <Field label="Notes">
              <textarea className="input" rows={2} value={editing.notes} onChange={set('notes')} />
            </Field>
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost min-h-12" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn-primary min-h-12" disabled={busy || photoBusy || hasDeployedErrors}>
                {busy ? <Spinner size={16} /> : (editing.id ? 'Save changes' : 'Add signage')}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete signage?">
        <p className="text-sm text-ink-600">
          Remove <span className="font-semibold">{removing?.type}</span> at{' '}
          <span className="font-semibold">{removing?.centerName}</span>? This can’t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn-danger" onClick={confirmDelete}>Delete</button>
        </div>
      </Modal>

      {/* Matrix cell — manage this site's records for one signage type */}
      <Modal open={!!cellView} onClose={() => setCellView(null)} title={cellView ? `${cellView.type} · ${cellView.site}` : ''}>
        {cellView && (() => {
          const recs = signages.filter((s) => s.centerName === cellView.site && s.type === cellView.type)
          return (
            <div>
              {recs.length === 0 ? (
                <p className="text-sm text-ink-500">No records left for this sign at this site.</p>
              ) : (
                <ul className="space-y-2">
                  {recs.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 rounded-xl border border-surface-200/60 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge color={SIGNAGE_STATUS_COLOR[signageStatus(s)]}>{signageStatus(s)}</Badge>
                          <ComplianceMark rec={s} />
                          <PhotoCount rec={s} />
                          {isFerp(s.type) && s.totalFloors ? (
                            <span className="text-xs text-ink-500">{ferpCovered(s)}/{s.totalFloors} floors</span>
                          ) : s.floor ? (
                            <span className="text-xs text-ink-500">Floor {s.floor}</span>
                          ) : null}
                          <span className="text-xs text-ink-400">Qty {s.quantity}</span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-ink-500">
                          {s.location || 'No location'}{s.lastChecked ? ` · checked ${s.lastChecked}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button className="btn-soft px-2 py-1.5" title="Edit" onClick={() => { setEditing(s); setCellView(null) }}><Pencil size={15} /></button>
                        <button className="btn-soft px-2 py-1.5 text-red-600" title="Remove (damaged / removed)" onClick={() => setRemoving(s)}><Trash2 size={15} /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex justify-end gap-2 border-t border-surface-200/60 pt-3">
                <button className="btn-ghost" onClick={() => setCellView(null)}>Close</button>
                <button className="btn-primary" onClick={() => { openAddFor(cellView.site, cellView.type); setCellView(null) }}>
                  <Plus size={16} /> Add another
                </button>
              </div>
            </div>
          )
        })()}
      </Modal>
      <LinkSitesModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        plan={linkPlan}
        linkedRows={linkedRows}
        initialTab={linkTab}
        onConfirm={doLinkSites}
        busy={busy}
        noun="signage record"
        nounPlural="signage records"
        idLabel="Signage"
        title="Signage and their sites"
      />

    </div>
  )
}
