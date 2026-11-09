import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import {
  Building2, Plus, Trash2, MapPin, Map as MapIcon, List, Pencil, Upload, Download, Search, X,
  CheckCircle2, AlertCircle, FireExtinguisher, HeartPulse, BriefcaseMedical, AlertTriangle,
  ListChecks, Users2, CheckSquare, BellRing, Tags,
} from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import {
  subscribeSites, createSite, updateSite, deleteSite, deleteSites, bulkUpsertSites,
  subscribeOrgUsers, subscribeCollections, emptyCollections, cleanAttributes, logAudit,
  updateOrgSettings, backfillEmptySiteTypes, assignSiteType,
} from '../../shared/org/orgData'
import { can, roleLabel } from '../../shared/auth/permissions'
import {
  PageHeader, Button, Modal, Field, Input, Select, SkeletonTable, EmptyState, Badge, StatCard,
  TableWrap,
} from '../../shared/ui'
// This page used to declare its own IncompleteNotice — same amber panel, same
// role="status", a different prop name (`notice` rather than `incomplete`) and
// a different sentence ("These counts are incomplete" vs "These figures are
// incomplete"). Two answers to one question, and the divergence was invisible
// because the two are 700 lines apart in different files.
import IncompleteNotice from '../../shared/ui/IncompleteNotice'
import { initials } from '../../shared/lib/format'
import { regionsOf, entitiesOf } from '../../shared/auth/access'
import { normalizeScopeConfig } from '../../shared/org/scopeConfig'
import {
  siteTypeOptions, canonicalFacility, rowsFromSiteTypeByEntity, packSiteTypeByEntity,
} from '../../shared/weather/activityPrecautions'
import SiteTypeBackfill from './SiteTypeBackfill'
import { siteStats, linkAssets } from './siteStats'
import { AUDIT } from '../../shared/audit/audit'
import {
  parseSitesCsv, planImport, updatePayload, sitesCsvTemplate, sitesToCsv, hasCoordinates, duplicateCodes,
} from './parseSitesCsv'
import { downloadText } from '../../shared/lib/download'
import { sameCentreId } from '../../shared/org/centreId'

const SitesMap = lazy(() => import('./SitesMap'))

const EMPTY = { name: '', code: '', region: '', entity: '', address: '', lat: '', lng: '', firstAidBoxes: '', facility: '', attributes: {} }

// The asset registers behind every per-site rollup on this page.
const COLLECTIONS = ['extinguishers', 'aeds', 'fas', 'incidents']

export default function Sites() {
  const { actor, role, org } = useAuth()
  const customFields = useMemo(() => normalizeScopeConfig(org?.scopeConfig).customFields, [org])
  const siteTypes = useMemo(() => siteTypeOptions(org?.activityTypes), [org])
  const [sites, setSites] = useState(null)
  const [users, setUsers] = useState([])
  const [store, setStore] = useState(() => emptyCollections(COLLECTIONS))
  const [tab, setTab] = useState('list')
  const [editing, setEditing] = useState(null) // 'new' | site | null
  const [form, setForm] = useState(EMPTY)
  const [selected, setSelected] = useState(null) // site for summary
  const [busy, setBusy] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkResult, setBulkResult] = useState(null) // { rows, valid, invalid, headerOk, fileName }
  const [bulkBusy, setBulkBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [regionFilter, setRegionFilter] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  // Bulk delete
  const [selectMode, setSelectMode] = useState(false)
  const [picked, setPicked] = useState([]) // site ids
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [typeOpen, setTypeOpen] = useState(false)
  const [bulkType, setBulkType] = useState('')
  const [typeRows, setTypeRows] = useState([])
  const [typeBusy, setTypeBusy] = useState(false)
  const canManage = can(role, 'site.manage')
  // The entity → site type list is stored on the organisation. Org update is
  // admin-only in the rules, so a manager who can edit sites still cannot
  // save that list. Setting a type on a site stays site.manage.
  const canMapTypes = can(role, 'org.settings')
  const viewTabs = useMemo(() => {
    const tabs = [
      { key: 'list', label: 'Sites', icon: List },
      { key: 'map', label: 'Map', icon: MapIcon },
    ]
    if (canMapTypes) tabs.push({ key: 'types', label: 'Site types', icon: Tags })
    return tabs
  }, [canMapTypes])
  const storedMapKey = JSON.stringify(org?.siteTypeByEntity || {})
  const activityKey = JSON.stringify(org?.activityTypes || [])
  // Keys, not `org`. A snapshot that changes neither the map nor the activity
  // list must not discard a row the admin is typing.
  useEffect(() => {
    setTypeRows(rowsFromSiteTypeByEntity(org?.siteTypeByEntity, org?.activityTypes))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedMapKey, activityKey])

  useEffect(() => {
    const unsubs = [
      subscribeSites(setSites),
      subscribeOrgUsers(setUsers),
      subscribeCollections(COLLECTIONS, setStore),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  const { extinguishers, aeds, fas, incidents } = store.data

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const setAttr = (k) => (e) => setForm((f) => ({ ...f, attributes: { ...f.attributes, [k]: e.target.value } }))

  const openNew = () => { setForm(EMPTY); setEditing('new') }
  const openEdit = (s) => {
    setForm({
      name: s.name || '', code: s.code || '', region: s.region || '', entity: s.entity || '', address: s.address || '',
      lat: s.lat ?? '', lng: s.lng ?? '', firstAidBoxes: s.firstAidBoxes ?? '',
      facility: s.facility || '',
      attributes: s.attributes || {},
    })
    setEditing(s)
    setSelected(null)
  }

  const save = async (e) => {
    e.preventDefault()
    // A colliding centre id is REFUSED, not warned about, for the same reason
    // the CSV import refuses one: the column exists to be a key, and two sites
    // claiming one makes every join on it ambiguous. The dashboard that results
    // is wrong without saying so, which is the worst way for this to fail.
    const code = String(form.code || '').trim()
    const clash = code && (sites || []).find((x) => sameCentreId(x.code, code) && x.id !== editing?.id)
    if (clash) {
      toast.error(`Centre ID ${code} already belongs to “${clash.name}”.`)
      return
    }
    if (editing === 'new' && !form.facility) {
      toast.error('Choose a site type. The weather digest uses it for this site’s precautions.')
      return
    }
    setBusy(true)
    try {
      if (editing === 'new') {
        await createSite(form, actor)
        toast.success('Site added')
      } else {
        await updateSite(editing.id, {
          name: form.name, code: form.code, region: form.region, entity: form.entity, address: form.address,
          lat: form.lat === '' ? null : Number(form.lat),
          lng: form.lng === '' ? null : Number(form.lng),
          firstAidBoxes: Number(form.firstAidBoxes) || 0,
          facility: form.facility || '',
          attributes: cleanAttributes(form.attributes),
        }, actor)
        toast.success('Site updated')
      }
      setEditing(null)
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (s) => {
    if (!window.confirm(`Delete site "${s.name}"?`)) return
    try {
      await deleteSite(s.id, actor, s.name)
      toast.success('Site deleted')
      setSelected(null)
    } catch (err) {
      toastCaught(err, 'Failed')
    }
  }

  const openBulk = () => { setBulkResult(null); setBulkOpen(true) }

  const onBulkFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    try {
      const res = planImport(await parseSitesCsv(file, customFields), sites || [], {
        activityTypes: org?.activityTypes || [],
      })
      setBulkResult({ ...res, fileName: file.name })
    } catch {
      toast.error('Could not read that CSV file')
    }
  }

  const saveCsv = (text, filename) => {
    downloadText(text, filename)
  }

  const downloadTemplate = () => saveCsv(sitesCsvTemplate(customFields), 'sites-template.csv')

  /**
   * The register as it is currently filtered, coordinates included.
   *
   * Exports what is ON SCREEN rather than everything: the filters are right
   * there, and a button that silently ignores them hands back a different list
   * from the one being looked at. The count goes in the toast so the two can be
   * compared without opening the file.
   *
   * Same columns the importer accepts, so this file can be edited and put back.
   */
  const exportSites = () => {
    const rows = filteredSites
    if (!rows.length) return toast.error('No sites to export')
    const withCoords = rows.filter(hasCoordinates).length
    saveCsv(sitesToCsv(rows, customFields), `sites-${rows.length}.csv`)
    // The register, coordinates included, has left the system. No preventive
    // control exists for a read the reader may make; the record that it
    // happened is what remains.
    logAudit(actor, AUDIT.EXPORT, {
      module: 'core',
      targetLabel: `${rows.length} sites`,
      summary: `Exported ${rows.length} sites (${withCoords} with coordinates)`,
    })
    toast.success(
      withCoords === rows.length
        ? `Exported ${rows.length} site${rows.length === 1 ? '' : 's'}`
        : `Exported ${rows.length} — ${rows.length - withCoords} without coordinates`,
    )
  }

  const importBulk = async () => {
    if (!bulkResult?.valid?.length) return
    setBulkBusy(true)
    try {
      // Rows that matched an existing site become edits to it, carrying only
      // the columns the file supplied — see updatePayload. Everything else is
      // a new site. The counts are reported back so an import that updated
      // when it was expected to insert says so rather than looking quiet.
      const byId = new Map((sites || []).map((s) => [s.id, s]))
      const updates = bulkResult.updates.map((r) => ({
        id: r.__match.id,
        // The name the REGISTER knows it by, not the spelling the spreadsheet
        // used — a trail saying "updated north  plant" is hard to match against
        // a site called North Plant. A genuine rename shows both.
        name: r.__match.renameTo ? `${r.__match.name} → ${r.__match.renameTo}` : r.__match.name,
        payload: updatePayload(r, byId.get(r.__match.id) || {}, bulkResult.present),
      }))
      const { created, updated } = await bulkUpsertSites({ creates: bulkResult.creates, updates }, actor)
      toast.success(
        [
          created && `${created} site${created === 1 ? '' : 's'} added`,
          updated && `${updated} updated`,
        ].filter(Boolean).join(', ') || 'Nothing to import',
      )
      setBulkOpen(false)
      setBulkResult(null)
    } catch (err) {
      toastCaught(err, 'Import failed')
    } finally {
      setBulkBusy(false)
    }
  }

  // Every asset resolved to a site once. Shared by the panel and the map so the
  // two can never disagree, and computed here because the per-site rollup below
  // walks every asset for every site.
  const links = useMemo(
    () => linkAssets([...extinguishers, ...aeds, ...fas], sites || []),
    [extinguishers, aeds, fas, sites]
  )

  const stats = useMemo(
    () => (selected ? siteStats(selected, { extinguishers, aeds, fas, incidents, users, links }) : null),
    [selected, extinguishers, aeds, fas, incidents, users, links]
  )

  // Pre-computed summary per site, for the map hover bubbles.
  const statsBySite = useMemo(() => {
    const m = {}
    ;(sites || []).forEach((s) => {
      m[s.id] = siteStats(s, { extinguishers, aeds, fas, incidents, users, links })
    })
    return m
  }, [sites, extinguishers, aeds, fas, incidents, users, links])

  const regionOptions = useMemo(() => regionsOf(sites || []), [sites])
  const entityOptions = useMemo(() => entitiesOf(sites || []), [sites])
  const activeFilters = Boolean(search.trim() || regionFilter || entityFilter)

  const filteredSites = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (sites || []).filter((s) => {
      if (regionFilter && s.region !== regionFilter) return false
      if (entityFilter && s.entity !== entityFilter) return false
      const typeText = s.facility || 'not set'
      if (q && !`${s.name} ${s.address || ''} ${s.region || ''} ${s.entity || ''} ${typeText}`.toLowerCase().includes(q))
        return false
      return true
    })
  }, [sites, search, regionFilter, entityFilter])

  // ── Bulk delete ────────────────────────────────────────────────────────────
  const togglePick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const exitSelect = () => { setSelectMode(false); setPicked([]) }
  const pickedSites = useMemo(
    () => (sites || []).filter((s) => picked.includes(s.id)),
    [sites, picked]
  )
  // Records already logged against the chosen sites — deleting a site does not
  // delete these, so the user should know what will be left referencing it.
  const pickedImpact = useMemo(() => {
    const sum = { extinguishers: 0, aeds: 0, fas: 0, incidents: 0, users: 0 }
    for (const s of pickedSites) {
      const st = statsBySite[s.id]
      if (!st) continue
      sum.extinguishers += st.extinguishers || 0
      sum.aeds += st.aeds || 0
      sum.fas += st.fas || 0
      sum.incidents += st.incidents || 0
      sum.users += st.users || 0
    }
    return sum
  }, [pickedSites, statsBySite])

  const runBulkType = async () => {
    const facility = canonicalFacility(bulkType, org?.activityTypes || [])
    if (!facility) return toast.error('Choose a site type')
    setBusy(true)
    try {
      const n = await assignSiteType(
        pickedSites.map((s) => ({ id: s.id, name: s.name, facility })),
        actor,
      )
      toast.success(`Set the site type on ${n} site${n === 1 ? '' : 's'}`)
      setTypeOpen(false)
      exitSelect()
    } catch (err) {
      toastCaught(err, 'Could not set the site type')
    } finally {
      setBusy(false)
    }
  }

  // Same write as Org Settings. Either screen stores the list the other reads
  // back, and Apply still fills only a site whose type is empty.
  const applyEntityMap = async (plan) => {
    setTypeBusy(true)
    try {
      const packed = packSiteTypeByEntity(typeRows, org?.activityTypes || [])
      await updateOrgSettings({ siteTypeByEntity: packed.map }, actor)
      const n = await backfillEmptySiteTypes(plan.updates, actor)
      toast.success(n ? `Filled the site type on ${n} site${n === 1 ? '' : 's'}` : 'No sites needed a type')
    } catch (err) {
      toastCaught(err, 'Could not fill site types')
    } finally {
      setTypeBusy(false)
    }
  }

  const runBulkDelete = async () => {
    if (confirmText.trim().toUpperCase() !== 'DELETE') return toast.error('Type DELETE to confirm')
    setBusy(true)
    try {
      const n = await deleteSites(pickedSites, actor)
      toast.success(`${n} site${n === 1 ? '' : 's'} deleted`)
      setConfirmBulk(false); setConfirmText(''); exitSelect(); setSelected(null)
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const clearFilters = () => {
    setSearch('')
    setRegionFilter('')
    setEntityFilter('')
  }

  return (
    <>
      <PageHeader
        title="Sites"
        subtitle="Locations & departments — mapped, with a live safety summary"
        icon={Building2}
        actions={
          // Export sits OUTSIDE the canManage gate on purpose: it writes
          // nothing, and every row in the file is already on the screen of
          // whoever clicked it. Gating a read behind a write permission is how
          // an auditor ends up asking someone else to send them a list they can
          // already see.
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" icon={Download} onClick={exportSites}>Export</Button>
            {canManage && (
              <>
                <Button variant="ghost" icon={Upload} onClick={openBulk}>Bulk upload</Button>
                <Button icon={Plus} onClick={openNew}>Add site</Button>
              </>
            )}
          </div>
        }
      />

      <IncompleteNotice incomplete={store.incomplete} className="mb-4" />

      <CentreIdNotice sites={sites} canManage={canManage} onExport={exportSites} onImport={() => setBulkOpen(true)} />

      {/* Tabs */}
      <div className="tab-strip mb-5" role="tablist" aria-label="Sites views">
        {viewTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setTab(t.key); if (t.key !== 'list') exitSelect() }}
            role="tab"
            aria-selected={tab === t.key}
            className={`nav-tab ${tab === t.key ? 'nav-tab-active' : 'nav-tab-idle'}`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'types' && canMapTypes && (
        <SiteTypeBackfill
          rows={typeRows}
          onChange={setTypeRows}
          activityTypes={org?.activityTypes || []}
          sites={sites || []}
          busy={typeBusy}
          onApply={applyEntityMap}
          note="Apply stores this list on the organisation and fills sites that still have no type. Preview counts them first."
        />
      )}

      {/* Bulk-select toolbar — appears above the filters while selecting */}
      {canManage && tab === 'list' && sites && sites.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {!selectMode ? (
            <Button variant="ghost" icon={CheckSquare} className="!py-2" onClick={() => setSelectMode(true)}>
              Select sites
            </Button>
          ) : (
            <>
              <Button variant="ghost" className="!py-2"
                onClick={() => setPicked(picked.length === filteredSites.length ? [] : filteredSites.map((s) => s.id))}>
                {picked.length === filteredSites.length ? 'Clear all' : `Select all${activeFilters ? ' shown' : ''} (${filteredSites.length})`}
              </Button>
              <span className="text-sm font-semibold text-ink-700">{picked.length} selected</span>
              <Button
                type="button"
                icon={Tags}
                variant="soft"
                className="!py-2"
                disabled={picked.length === 0}
                onClick={() => { setBulkType(''); setTypeOpen(true) }}
              >
                Set site type
              </Button>
              <Button
                icon={Trash2}
                variant="danger"
                className="!py-2"
                disabled={picked.length === 0}
                onClick={() => { setConfirmText(''); setConfirmBulk(true) }}
              >
                Delete {picked.length || ''}
              </Button>
              <Button variant="ghost" icon={X} className="!py-2" onClick={exitSelect}>Cancel</Button>
            </>
          )}
        </div>
      )}

      {/* Search + Region / Entity filters (apply to list and map) */}
      {tab !== 'types' && sites && sites.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <Input
              className="!py-2 pl-9"
              aria-label="Search sites"
              placeholder="Search sites…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select aria-label="Filter by region" className="!py-2 sm:!w-44" value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
            <option value="">All regions</option>
            {regionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          <Select aria-label="Filter by entity" className="!py-2 sm:!w-52" value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
            <option value="">All entities</option>
            {entityOptions.map((en) => <option key={en} value={en}>{en}</option>)}
          </Select>
          {activeFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 rounded-xl px-2.5 py-2 text-sm font-medium text-ink-500 hover:bg-surface-100 active:scale-95"
            >
              <X size={15} /> Clear
            </button>
          )}
          <span className="text-xs text-ink-400 sm:ml-auto">
            {filteredSites.length} of {sites.length}
          </span>
        </div>
      )}

      {/* List / Map */}
      {tab === 'types' ? null : sites === null ? (
        <SkeletonTable rows={4} cols={3} />
      ) : sites.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No sites yet"
          description="Add your workplaces so records can be organized and mapped by location."
          action={canManage && <Button icon={Plus} onClick={openNew}>Add site</Button>}
        />
      ) : tab === 'map' ? (
        <Suspense fallback={<SkeletonTable rows={4} cols={2} />}>
          <SitesMap
            sites={filteredSites}
            stats={statsBySite}
            onSelect={(s) => { setTab('list'); setSelected(s) }}
            onEdit={(s) => { setTab('list'); openEdit(s) }}
            onDelete={(s) => { setTab('list'); remove(s) }}
            canManage={canManage}
          />
        </Suspense>
      ) : filteredSites.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching sites"
          description="No sites match your search or filters."
          action={<Button variant="ghost" onClick={clearFilters}>Clear filters</Button>}
        />
      ) : (
        <TableWrap>
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-400">
                {selectMode && (
                  <th className="w-12 px-4 py-3 font-semibold">
                    <span className="sr-only">Select</span>
                  </th>
                )}
                <th className="px-5 py-3 font-semibold">Site</th>
                <th className="px-5 py-3 font-semibold">Site type</th>
                <th className="px-5 py-3 font-semibold">Region</th>
                <th className="px-5 py-3 font-semibold">Entity</th>
                <th className="px-5 py-3 font-semibold">Address</th>
                {canManage && (
                  <th className="px-5 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredSites.map((s) => (
                <tr key={s.id} className={selectMode && picked.includes(s.id) ? 'bg-red-50' : 'hover:bg-surface-100'}>
                  {selectMode && (
                    <td className="px-4 py-3.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        aria-label={`Select ${s.name}`}
                        checked={picked.includes(s.id)}
                        onChange={() => togglePick(s.id)}
                      />
                    </td>
                  )}
                  <td className="px-5 py-3.5">
                    <button type="button" className="text-left font-semibold text-ink-900 underline-offset-2 hover:text-brand-700 hover:underline" onClick={() => setSelected(s)}>
                      {s.name}
                    </button>
                    {s.code && (
                      <p className="mt-0.5 font-mono text-[11.5px] tracking-wide text-ink-400">ID {s.code}</p>
                    )}
                  </td>
                  <td className={`px-5 py-3.5 ${s.facility ? 'text-ink-700' : 'font-medium text-amber-700'}`}>
                    {s.facility || 'Not set'}
                  </td>
                  <td className="px-5 py-3.5 text-ink-600">{s.region || '—'}</td>
                  <td className="px-5 py-3.5 text-ink-600">{s.entity || '—'}</td>
                  <td className="px-5 py-3.5 text-ink-500">
                    {s.address ? (
                      <span className="inline-flex items-center gap-1"><MapPin size={13} /> {s.address}</span>
                    ) : '—'}
                  </td>
                  {canManage && (
                    <td className="px-5 py-3.5 text-right">
                      <Button type="button" variant="ghost" className="!py-1.5" icon={Pencil} onClick={() => openEdit(s)}>
                        Edit <span className="sr-only">{s.name}</span>
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {/* Create / edit modal */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add site' : 'Edit site'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="site-form" type="submit" loading={busy}>
              {editing === 'new' ? 'Add site' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form id="site-form" onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Site name *" htmlFor="name">
              <Input id="name" required value={form.name} onChange={set('name')} placeholder="e.g. North Plant" />
            </Field>
          </div>
          {/* Beside the name, because it identifies the same thing. */}
          <Field label="Centre ID" htmlFor="code" hint={codeHint(form.code, editing, sites)}>
            <Input id="code" value={form.code} onChange={set('code')} placeholder="e.g. 201" />
          </Field>
          <Field label="Region" htmlFor="region">
            <Input id="region" value={form.region} onChange={set('region')} placeholder="e.g. North" />
          </Field>
          <Field label="Entity" htmlFor="entity">
            <Input id="entity" value={form.entity} onChange={set('entity')} placeholder="e.g. Acme Mfg Pvt Ltd" />
          </Field>
          <Field
            label={editing === 'new' ? 'Site type *' : 'Site type'}
            htmlFor="facility"
            hint={
              editing === 'new'
                ? 'Required. The weather digest takes this site’s precautions from the type.'
                : form.facility
                  ? 'The weather digest takes this site’s precautions from the type.'
                  : 'Not set. Choose a type so the weather digest can use it. You can still save other changes.'
            }
          >
            <Select id="facility" required={editing === 'new'} value={form.facility || ''} onChange={set('facility')}>
              {editing === 'new' ? (
                <option value="" disabled>Select a site type</option>
              ) : (
                <option value="">Not set</option>
              )}
              <optgroup label="General">
                {siteTypes.general.map((label) => (
                  <option key={label} value={label}>{label}</option>
                ))}
              </optgroup>
              {siteTypes.extra.length > 0 && (
                <optgroup label="This organisation">
                  {siteTypes.extra.map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Address" htmlFor="address">
              <Input id="address" value={form.address} onChange={set('address')} placeholder="Street, City, Country" />
            </Field>
          </div>
          <Field label="Latitude" htmlFor="lat" hint="Decimal, e.g. 53.8008">
            <Input id="lat" type="number" step="any" value={form.lat} onChange={set('lat')} placeholder="53.8008" />
          </Field>
          <Field label="Longitude" htmlFor="lng" hint="Decimal, e.g. -1.5491">
            <Input id="lng" type="number" step="any" value={form.lng} onChange={set('lng')} placeholder="-1.5491" />
          </Field>
          <Field label="First aid boxes" htmlFor="fab" hint="Count at this site">
            <Input id="fab" type="number" min="0" value={form.firstAidBoxes} onChange={set('firstAidBoxes')} placeholder="0" />
          </Field>
          {customFields.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`attr-${f.key}`} hint="Custom scope field">
              <Input id={`attr-${f.key}`} value={form.attributes?.[f.key] || ''} onChange={setAttr(f.key)} placeholder={`e.g. ${f.label}`} />
            </Field>
          ))}
        </form>
      </Modal>

      {/* Site summary */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        size="xl"
        title={
          selected ? (
            <span className="flex flex-col">
              <span className="text-lg font-bold text-ink-900">{selected.name}</span>
              <span className="text-xs font-normal text-ink-500">
                {[
                  selected.facility ? `Site type: ${selected.facility}` : 'Site type: Not set',
                  selected.region && `Region: ${selected.region}`,
                  selected.entity && `Entity: ${selected.entity}`,
                ].filter(Boolean).join('  ·  ')}
                {selected.address ? `  ·  ${selected.address}` : ''}
              </span>
            </span>
          ) : ''
        }
        footer={
          selected && canManage && (
            <div className="flex w-full items-center justify-between">
              <Button variant="danger" icon={Trash2} type="button" onClick={() => remove(selected)}>Delete</Button>
              <Button variant="ghost" icon={Pencil} type="button" onClick={() => openEdit(selected)}>Edit</Button>
            </div>
          )
        }
      >
        {selected && stats && (
          <div className="space-y-5">
            <IncompleteNotice incomplete={store.incomplete} />

            {/* Equipment + safety KPIs */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard label="Fire Extinguishers" value={stats.extinguishers} icon={FireExtinguisher} tone="red" />
              <StatCard label="AED units" value={stats.aeds} icon={HeartPulse} tone="brand" />
              <StatCard label="Fire alarm devices" value={stats.fas} icon={BellRing} tone="amber" />
              <StatCard label="First Aid Boxes" value={stats.firstAidBoxes} icon={BriefcaseMedical} tone="green" />
              <StatCard label="Incidents (total)" value={stats.incidentsTotal} icon={AlertTriangle} tone="amber" />
              <StatCard label="Open Actions" value={stats.openActions} icon={ListChecks} tone="violet" />
              <StatCard label="Employees mapped" value={stats.employees.length} icon={Users2} tone="blue" />
            </div>

            {/* Incident breakdown */}
            <div className="card p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-400">Incidents by type</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Fire', stats.byType.fire, 'red'],
                  ['Property damage', stats.byType.property, 'amber'],
                  ['Near miss', stats.byType.nearMiss, 'blue'],
                  ['First aid', stats.byType.firstAid, 'green'],
                ].map(([label, val, tone]) => (
                  <div key={label} className="well rounded-2xl p-3 text-center">
                    <p className="text-2xl font-bold text-ink-900">{val}</p>
                    <Badge tone={tone}>{label}</Badge>
                  </div>
                ))}
              </div>
            </div>

            {/* Employees list */}
            <div className="card p-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-ink-400">
                Employees mapped to this site ({stats.employees.length})
              </p>
              {stats.employees.length === 0 ? (
                <p className="text-sm text-ink-400">
                  No employees mapped yet. Assign people to this site from the <b>Users</b> page.
                </p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {stats.employees.map((u) => (
                    <li key={u.uid} className="flex items-center gap-3 py-2.5">
                      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 text-xs font-bold text-white">
                        {initials(u.name) || 'U'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-900">{u.name}</p>
                        <p className="truncate text-xs text-ink-400">{u.email}{u.dept ? ` · ${u.dept}` : ''}</p>
                      </div>
                      <Badge tone="gray">{roleLabel(u.role)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk upload */}
      <Modal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk upload sites"
        size="xl"
        footer={
          <div className="flex w-full items-center justify-between">
            <Button variant="ghost" icon={Download} type="button" onClick={downloadTemplate}>
              Template
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" type="button" onClick={() => setBulkOpen(false)}>Cancel</Button>
              <Button
                type="button"
                loading={bulkBusy}
                disabled={!bulkResult?.valid?.length}
                onClick={importBulk}
              >
                {importLabel(bulkResult)}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-500">
            Upload a CSV with columns{' '}
            <b>Site Name, Site Type, Centre ID, Region, Entity, Address, Latitude, Longitude, First Aid Boxes{customFields.map((f) => `, ${f.label}`).join('')}</b>.
            From Excel, save the sheet as CSV. A <b>new</b> site needs a site type. Rows without
            a valid <b>latitude and longitude</b> are rejected and will not be imported.
          </p>
          <p className="text-sm text-ink-500">
            A row matching a site you already have — by <b>Centre ID</b>, or failing that by
            <b> name</b> — updates that site instead of adding a second one. Only the columns your
            file actually contains are touched, so a spreadsheet of names and IDs will not blank
            the addresses. Every row is listed below before anything is written.
          </p>

          <label className="well flex cursor-pointer flex-col items-center gap-2 rounded-2xl p-6 text-center transition hover:bg-surface-100">
            <Upload size={22} className="text-brand-600" />
            <span className="text-sm font-medium text-ink-700">
              {bulkResult ? bulkResult.fileName : 'Choose a CSV file'}
            </span>
            <span className="text-xs text-ink-400">Click to browse — .csv</span>
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onBulkFile} />
          </label>

          {bulkResult && !bulkResult.headerOk && (
            <div className="flex items-center gap-2 rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle size={16} /> Couldn&apos;t find the required columns (Site Name, Latitude,
              Longitude). Check the header row or download the template.
            </div>
          )}

          {bulkResult && bulkResult.headerOk && (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge tone="green">
                  <CheckCircle2 size={13} /> {bulkResult.creates.length} new
                </Badge>
                {bulkResult.updates.length > 0 && (
                  <Badge tone="amber">
                    <Pencil size={13} /> {bulkResult.updates.length} existing site
                    {bulkResult.updates.length === 1 ? '' : 's'} updated
                  </Badge>
                )}
                {bulkResult.invalid.length > 0 && (
                  <Badge tone="red">
                    <AlertCircle size={13} /> {bulkResult.invalid.length} rejected
                  </Badge>
                )}
              </div>
              <div className="table-crisp card max-h-72 overflow-auto p-0">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-400">
                      <th className="px-4 py-2">Row</th>
                      <th className="px-4 py-2">Name</th>
                      <th className="px-4 py-2">Centre ID</th>
                      <th className="px-4 py-2">Region / Entity</th>
                      <th className="px-4 py-2">Lat, Lng</th>
                      <th className="px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkResult.rows.map((r) => (
                      <tr key={r.__row} className={r.__errors.length ? 'bg-red-50/40' : ''}>
                        <td className="px-4 py-2 text-ink-400">{r.__row}</td>
                        <td className="px-4 py-2 font-medium text-ink-800">{r.name || '—'}</td>
                        <td className="px-4 py-2 font-mono text-[12px] text-ink-500">{r.code || '—'}</td>
                        <td className="px-4 py-2 text-ink-500">
                          {[r.region, r.entity].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-4 py-2 text-ink-500">
                          {r.lat != null && r.lng != null ? `${r.lat}, ${r.lng}` : '—'}
                        </td>
                        <td className="px-4 py-2">
                          {r.__errors.length === 0 ? (
                            r.__match ? (
                              <span className="inline-flex flex-col gap-0.5 text-amber-700">
                                <span className="inline-flex items-center gap-1 font-medium">
                                  <Pencil size={13} /> Updates “{r.__match.name}”
                                  <span className="text-ink-400">
                                    (matched on {r.__match.by === 'id' ? 'centre ID' : 'name'})
                                  </span>
                                </span>
                                <span className="text-[11.5px] text-ink-500">
                                  {changeSummary(r.__changes, r.__match.renameTo)}
                                </span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-emerald-600">
                                <CheckCircle2 size={14} /> New site
                              </span>
                            )
                          ) : (
                            <span className="inline-flex items-center gap-1 text-red-600">
                              <AlertCircle size={14} /> {r.__errors.join('; ')}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={typeOpen}
        onClose={() => setTypeOpen(false)}
        title={`Set site type on ${pickedSites.length} site${pickedSites.length === 1 ? '' : 's'}`}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setTypeOpen(false)}>Cancel</Button>
            <Button type="button" loading={busy} disabled={!bulkType} onClick={runBulkType}>
              Apply site type
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            This replaces the site type on every selected site, including one that already has a type.
            The weather digest takes each site’s precautions from the type you set.
          </p>
          <Field label="Site type" htmlFor="bulk-facility">
            <Select id="bulk-facility" value={bulkType} onChange={(e) => setBulkType(e.target.value)}>
              <option value="">Select a site type</option>
              <optgroup label="General">
                {siteTypes.general.map((label) => (
                  <option key={label} value={label}>{label}</option>
                ))}
              </optgroup>
              {siteTypes.extra.length > 0 && (
                <optgroup label="This organisation">
                  {siteTypes.extra.map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
        </div>
      </Modal>

      {/* Bulk delete confirmation */}
      <Modal
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        title={`Delete ${pickedSites.length} site${pickedSites.length === 1 ? '' : 's'}?`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setConfirmBulk(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={busy}
              disabled={confirmText.trim().toUpperCase() !== 'DELETE'}
              onClick={runBulkDelete}
            >
              Delete {pickedSites.length} site{pickedSites.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-600">
            This permanently removes the sites below from your organisation. It cannot be undone.
          </p>

          <div className="max-h-56 overflow-auto rounded-2xl border border-surface-200">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-surface-100">
                {pickedSites.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-2 font-medium text-ink-800">{s.name}</td>
                    <td className="px-4 py-2 text-ink-500">
                      {[s.region, s.entity].filter(Boolean).join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Outside the impact block below on purpose: when a register was
              capped or failed to load, the linked-records tally can read zero
              for sites that do have records, and this is the only thing that
              would tell you. */}
          <IncompleteNotice incomplete={store.incomplete} />

          {(pickedImpact.extinguishers + pickedImpact.aeds + pickedImpact.fas + pickedImpact.incidents + pickedImpact.users) > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="flex items-center gap-2 font-semibold">
                <AlertTriangle size={16} /> Records are linked to these sites
              </p>
              <p className="mt-1">
                {[
                  pickedImpact.users && `${pickedImpact.users} people`,
                  pickedImpact.incidents && `${pickedImpact.incidents} incidents`,
                  pickedImpact.extinguishers && `${pickedImpact.extinguishers} extinguishers`,
                  pickedImpact.aeds && `${pickedImpact.aeds} AEDs`,
                  pickedImpact.fas && `${pickedImpact.fas} fire-alarm devices`,
                ].filter(Boolean).join(', ')}{' '}
                stay in the system and keep their stored site name, so history and reports remain readable.
                Reassign anyone who still needs an active site.
              </p>
            </div>
          )}

          <Field label="Type DELETE to confirm">
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
          </Field>
        </div>
      </Modal>

    </>
  )
}

/**
 * What an update would actually change, in a line.
 *
 * Named fields rather than a count, because "3 fields" tells nobody whether the
 * import is about to correct a coordinate or rewrite every address. A rename
 * leads, since it is the change most likely to be unintended.
 */
function changeSummary(changes = {}, renameTo = '') {
  const keys = Object.keys(changes).filter((k) => k !== 'name')
  const parts = []
  if (renameTo) parts.push(`renames to “${renameTo}”`)
  if (keys.length) {
    const pretty = keys.map((k) => k.replace(/^attributes\./, '').replace(/([A-Z])/g, ' $1').toLowerCase())
    parts.push(`changes ${pretty.slice(0, 4).join(', ')}${pretty.length > 4 ? `, +${pretty.length - 4} more` : ''}`)
  }
  return parts.length ? parts.join(' · ') : 'no change — the row matches what is stored'
}

/** The import button's label: what will happen, not how many rows were read. */
function importLabel(result) {
  const created = result?.creates?.length || 0
  const updated = result?.updates?.length || 0
  if (!created && !updated) return 'Import'
  if (!created) return `Update ${updated}`
  if (!updated) return `Add ${created}`
  return `Add ${created}, update ${updated}`
}

/**
 * How much of the register carries a centre id, and how to finish the job.
 *
 * Shown only while it is actionable: silent once every site has one, and
 * silent for someone who cannot edit sites anyway. The route it names —
 * export, paste the ids in beside the names, import the same file back — is
 * the only realistic one for an estate of any size, and it is not discoverable
 * from two buttons at opposite ends of a toolbar.
 *
 * A duplicate is called out separately and first. Missing ids make a join
 * incomplete, which shows up as a thin map; duplicated ids make it WRONG, which
 * shows up as one centre's audits filed under another and nothing saying so.
 */
function CentreIdNotice({ sites, canManage, onExport, onImport }) {
  if (!canManage || !sites || sites.length === 0) return null
  const withCode = sites.filter((s) => String(s.code || '').trim()).length
  const dupes = duplicateCodes(sites)
  if (withCode === sites.length && dupes.length === 0) return null

  const missing = sites.length - withCode
  const bad = dupes.length > 0

  return (
    <div
      role="status"
      className={`mb-4 rounded-2xl border p-4 shadow-elev-sm ${
        bad ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <p className={`flex items-center gap-2 text-sm font-semibold ${bad ? 'text-red-900' : 'text-amber-900'}`}>
        <AlertTriangle size={16} />
        {bad
          ? `${dupes.length} centre ID${dupes.length === 1 ? ' is' : 's are'} used by more than one site`
          : `${missing} of ${sites.length} site${sites.length === 1 ? '' : 's'} have no centre ID`}
      </p>
      <p className={`mt-1 text-[13px] leading-relaxed ${bad ? 'text-red-900' : 'text-amber-900'}`}>
        {bad ? (
          <>
            {dupes.slice(0, 3).map(([code, names]) => `${code} (${names.join(', ')})`).join('; ')}
            {dupes.length > 3 ? `, and ${dupes.length - 3} more` : ''}. Analytics → ODIN matches
            warehouse rows to a site on this ID, so a shared one files a centre’s audits under
            whichever site the lookup happens to reach. Give each its own.
          </>
        ) : (
          <>
            Analytics → ODIN matches warehouse rows to a site on this ID; without one it falls back
            to matching on name, which misses anything spelled differently. For more than a handful,
            export the register, paste the IDs into the <b>Centre ID</b> column beside the names, and
            import the same file back.
          </>
        )}
      </p>
      {!bad && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="ghost" icon={Download} className="!py-1.5 !text-[12.5px]" onClick={onExport}>
            Export the register
          </Button>
          <Button variant="ghost" icon={Upload} className="!py-1.5 !text-[12.5px]" onClick={onImport}>
            Import it back
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * What sits under the Centre ID box.
 *
 * A live collision is the most useful thing this field can say, so it outranks
 * the explanation — an admin who has just typed an id another site already
 * holds needs to know now, not when a dashboard starts attributing one centre's
 * audits to another.
 */
function codeHint(code, editing, sites) {
  const value = String(code || '').trim()
  const clash = value && (sites || []).find(
    (s) => sameCentreId(s.code, value) && s.id !== editing?.id
  )
  if (clash) return `“${clash.name}” already uses this ID — two sites cannot share one.`
  return 'This site’s ID in the system that owns it — a centre service ID, a store code. Analytics → ODIN matches warehouse rows to this site on it.'
}
