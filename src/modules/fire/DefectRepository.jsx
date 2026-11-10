import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { format } from 'date-fns'
import { Wrench, CheckCircle2, Download, X, Flame, HeartPulse, BellRing } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Badge } from './components/ui'
import { Pager } from '../../shared/ui'
import { usePagination } from '../../shared/ui/usePagination'
import { useFleet } from './context/FleetContext'
import { useAuth } from './context/AuthContext'
import { decideAssetReport } from './lib/data'
import CloseDefectModal from './components/CloseDefectModal'
import { toDate } from './lib/extinguisherLogic'
import { exportDefectRepository } from './lib/exporter'
import { buildDefectRepositoryRows } from './lib/defectRepositoryExport'
import { Link } from 'react-router-dom'
import { deriveExtinguisherDefects, DERIVED_DEFECT } from './lib/derivedExtDefects'
import { isHptOverdue, HPT_BLOCKS_RESOLVE } from './lib/hpt'
import { DEFECT_BY_KEY, PHYSICAL_DEFECT_KEYS, REGION_COLORS } from './lib/constants'
import ListFilters from './components/ListFilters'
import {
  emptyDefectFilters,
  applyDefectFilters,
  hasActiveDefectFilters,
  defectFieldDefs,
  defectExportFilename,
} from './lib/defectFilters'

// One place for every reported equipment defect — fire extinguishers (open
// physical defects, HPT due, empty) plus AED / fire-alarm QR-scan reports —
// and for the closures that take them off that list.
function rowFromClosure(c) {
  const isFas = c.kind === 'fas' || c.assetKind === 'fas'
  const isAed = c.kind === 'aed' || c.assetKind === 'aed'
  const derived = c.defectType === 'hpt_due' || c.defectType === 'empty'
  return {
    key: `closed:${c.id}`,
    kind: isFas ? 'Fire Alarm' : isAed ? 'AED' : 'Extinguisher',
    icon: isFas ? BellRing : isAed ? HeartPulse : Flame,
    color: isFas ? '#f59e0b' : isAed ? '#0ea5e9' : '#dc2626',
    label: c.serialNo || '—',
    sub: [c.type, c.capacity].filter(Boolean).join(' · '),
    site: c.centerName || '',
    region: c.region || '',
    entity: c.entity || '',
    location: c.location || '',
    defect: c.defectLabel || c.defectType || 'Defect',
    defectColor:
      c.defectType === 'hpt_due'
        ? DERIVED_DEFECT.HPT_DUE.color
        : DEFECT_BY_KEY[c.defectType]?.color || '#64748b',
    reportedAt: null,
    source: isFas || isAed ? 'asset' : derived ? 'derived' : 'ext',
    closure: c,
    raw: { ...c, assetKind: isFas ? 'fas' : isAed ? 'aed' : c.assetKind || '' },
  }
}

export default function DefectRepository() {
  const { physicalOpen, pendingReports, extinguishers, aeds, fas, defectClosures = [] } = useFleet()
  const { orgName, profile, isManager } = useAuth()
  const [busyId, setBusyId] = useState(null)
  const [closeFor, setCloseFor] = useState(null)
  const [filters, setFilters] = useState(emptyDefectFilters)

  const fmt = (v) => {
    const d = toDate(v)
    return d ? format(d, 'dd MMM yyyy') : '—'
  }

  const rows = useMemo(() => {
    const extById = new Map((extinguishers || []).map((e) => [e.id, e]))
    const aedById = new Map((aeds || []).map((a) => [a.id, a]))
    const fasById = new Map((fas || []).map((a) => [a.id, a]))
    const ext = (physicalOpen || []).map((r) => ({
      key: `ext:${r.id}`,
      kind: 'Extinguisher',
      icon: Flame,
      color: '#dc2626',
      label: r.serialNo || '—',
      sub: [r.type, r.capacity].filter(Boolean).join(' · '),
      site: r.centerName || '',
      region: r.region || '',
      entity: r.entity || extById.get(r.extId)?.entity || '',
      location: extById.get(r.extId)?.location || r.location || '',
      defect: r.defectLabel,
      defectColor: DEFECT_BY_KEY[r.defectType]?.color || '#64748b',
      reportedAt: r.reportedAt,
      source: 'ext',
      // Closing the reported defect removes that key. The rules refuse the
      // removal while the hydrostatic test is overdue, so the button must not
      // offer a write that will be rejected.
      hptDue: PHYSICAL_DEFECT_KEYS.includes(r.defectType) && isHptOverdue(extById.get(r.extId)),
      raw: r,
    }))
    // HPT-due and Empty units straight from the register (see derivedExtDefects).
    const seen = new Set((physicalOpen || []).map((r) => `${r.extId}:${r.defectType}`))
    const derived = deriveExtinguisherDefects(extinguishers || [], seen).map((r) => ({
      key: `derived:${r.id}`,
      kind: 'Extinguisher',
      icon: Flame,
      color: '#dc2626',
      label: r.serialNo || '—',
      sub: [r.type, r.capacity, r.location].filter(Boolean).join(' · '),
      site: r.centerName || '',
      region: r.region || '',
      entity: r.entity || '',
      location: r.location || '',
      defect: r.defectLabel,
      defectColor: r.defectColor,
      reportedAt: null,
      dueDate: r.dueDate || null,
      source: 'derived',
      raw: r,
    }))
    const asset = (pendingReports || [])
      .filter((r) => r.kind === 'asset_defect')
      .map((r) => {
        // A QR report carries only the asset id/label; site, region and entity
        // come from the (already access-scoped) AED / FAS register.
        const a = (r.assetKind === 'fas' ? fasById : aedById).get(r.assetRefId) || {}
        return {
          key: `asset:${r.id}`,
          kind: r.assetKind === 'fas' ? 'Fire Alarm' : 'AED',
          icon: r.assetKind === 'fas' ? BellRing : HeartPulse,
          color: r.assetKind === 'fas' ? '#f59e0b' : '#0ea5e9',
          label: r.assetLabel || '—',
          sub: 'Reported via QR scan',
          site: a.centerName || '',
          region: a.region || '',
          entity: a.entity || '',
          location: a.location || '',
          assetId: (r.assetKind === 'fas' ? a.deviceId : a.assetId) || '',
          defect: r.defect,
          defectColor: '#dc2626',
          reportedAt: r.reportedAt,
          source: 'asset',
          raw: r,
        }
      })
    return [...ext, ...derived, ...asset].sort(
      (a, b) => (toDate(b.reportedAt)?.getTime() || 0) - (toDate(a.reportedAt)?.getTime() || 0)
    )
  }, [physicalOpen, pendingReports, extinguishers, aeds, fas])

  const closedRows = useMemo(() => (defectClosures || []).map(rowFromClosure), [defectClosures])
  // Closed rows stay out of the default list. The open count is what the
  // dashboard, this page, and the site-lookup snapshot all mean by "open",
  // and folding closures in would make an untouched filter read high.
  // Selecting Closed is what brings them in, and the chip options are built
  // from both so that choice exists before any closed row is on screen.
  const wantsClosed = (filters.status || []).some(
    (s) => String(s).trim().toLowerCase() === 'closed'
  )
  const base = useMemo(
    () => (wantsClosed ? [...rows, ...closedRows] : rows),
    [wantsClosed, rows, closedRows]
  )
  const catalog = useMemo(() => [...rows, ...closedRows], [rows, closedRows])

  const fieldDefs = useMemo(() => defectFieldDefs(catalog), [catalog])
  const visible = useMemo(() => applyDefectFilters(base, filters), [base, filters])
  const filtered = hasActiveDefectFilters(filters)
  const listed = rows.length > 0 || closedRows.length > 0

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(visible)

  // Every defect matching the filters, not just the page on screen — the
  // workbook is the whole filtered set so it is never cut off at a page boundary.
  const doExport = () => {
    if (!visible.length)
      return toast.error(filtered ? 'No defects match the filters' : 'No defects to export')
    try {
      exportDefectRepository(
        buildDefectRepositoryRows(visible, { aeds, fas, extinguishers }),
        defectExportFilename(filters)
      )
      toast.success(`Exported ${visible.length} defect${visible.length === 1 ? '' : 's'}`)
    } catch (err) {
      toastCaught(err, 'Could not export the defects')
    }
  }

  const decideAsset = async (row, approve) => {
    setBusyId(row.key)
    try {
      await decideAssetReport(row.raw, approve, profile?.name, {
        uid: profile?.uid,
        name: profile?.name,
      })
      toast.success(
        approve ? 'Defect confirmed — asset flagged & report closed' : 'Defect report dismissed'
      )
    } catch (err) {
      toastCaught(err, 'Could not update the report')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Defect Repository"
        subtitle="Every open equipment defect — extinguishers, AED and fire-alarm. Close one here; closed defects stay under the Closed filter."
        icon={Wrench}
      >
        <button className="btn-ghost" onClick={doExport}>
          <Download size={16} /> Export
        </button>
      </PageHeader>

      {listed && (
        <ListFilters
          filters={filters}
          onChange={setFilters}
          fields={['kind', 'defect', 'source', 'status', 'region', 'entity', 'site']}
          fieldDefs={fieldDefs}
          isActive={hasActiveDefectFilters}
          onClear={() => setFilters(emptyDefectFilters())}
          searchPlaceholder="Search serial, asset ID, site, location or defect…"
        >
          <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
            <span className="w-16 shrink-0 text-xs font-bold uppercase tracking-wide text-ink-400">
              Date
            </span>
            <label className="flex items-center gap-1.5 text-xs text-ink-500">
              From
              <input
                type="date"
                aria-label="From date"
                className="input w-auto py-1.5"
                value={filters.from}
                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-500">
              To
              <input
                type="date"
                aria-label="To date"
                className="input w-auto py-1.5"
                value={filters.to}
                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              />
            </label>
            <span className="text-xs text-ink-400">
              Reported date, or the closed date once a defect is closed
            </span>
            <span className="ml-auto text-xs font-semibold text-ink-600" data-testid="defect-count">
              {filtered
                ? `${visible.length} of ${base.length} defects`
                : `${rows.length} defect${rows.length === 1 ? '' : 's'}`}
            </span>
          </div>
        </ListFilters>
      )}

      {visible.length === 0 && filtered ? (
        <EmptyState
          icon={Wrench}
          title="No defects match the filters"
          hint="Clear or loosen the filters to see more."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No open defects"
          hint="Reported defects across all emergency equipment appear here for closure. 🛠️"
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3">Equipment</th>
                  <th className="px-4 py-3">Identifier</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Defect</th>
                  <th className="px-4 py-3">Reported</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((row, i) => {
                  const Icon = row.icon
                  return (
                    <motion.tr
                      key={row.key}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.02, 0.4) }}
                      className="hover:bg-surface-100/50"
                      style={{ boxShadow: `inset 4px 0 0 ${row.color}` }}
                    >
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-2 font-semibold text-ink-800">
                          <Icon size={15} style={{ color: row.color }} /> {row.kind}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-ink-900">{row.label}</div>
                        {row.sub && <div className="text-xs text-ink-500">{row.sub}</div>}
                      </td>
                      <td className="px-4 py-3 text-ink-700">
                        {row.site || <span className="text-ink-300">—</span>}
                        {row.region && (
                          <Badge className="ml-1.5" color={REGION_COLORS[row.region] || '#64748b'}>
                            {row.region}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge color={row.defectColor}>{row.defect}</Badge>
                        {row.closure && (
                          <Badge className="ml-1.5" color="#64748b">
                            Closed
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-600">
                        {row.source === 'derived' ? (
                          row.dueDate ? (
                            <span>Due {fmt(row.dueDate)}</span>
                          ) : (
                            <span className="text-xs text-ink-400">From register</span>
                          )
                        ) : (
                          fmt(row.reportedAt)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.closure ? (
                          <span className="text-xs text-ink-500">
                            {row.closure.closedBy ? `Closed by ${row.closure.closedBy}` : 'Closed'}
                          </span>
                        ) : (
                          <div className="inline-flex flex-wrap justify-end gap-1.5">
                            {row.source === 'derived' && (
                              <Link
                                to="/equipment/refill-due"
                                className="btn-ghost px-2.5 py-1.5 text-xs font-semibold"
                                title="Cleared by recording the HPT / refill on the extinguisher"
                              >
                                Open extinguisher
                              </Link>
                            )}
                            {!isManager ? (
                              row.source === 'derived' ? null : (
                                <span className="text-xs text-ink-400">Manager only</span>
                              )
                            ) : (
                              <>
                                {row.hptDue ? (
                                  <span className="text-xs font-semibold text-violet-700" title={HPT_BLOCKS_RESOLVE}>
                                    HPT due
                                  </span>
                                ) : (
                                  <button
                                    className="btn-ghost px-2.5 py-1.5 text-xs font-semibold text-green-600 hover:bg-green-50"
                                    disabled={busyId === row.key}
                                    onClick={() => setCloseFor(row)}
                                    title="Close this defect"
                                  >
                                    <CheckCircle2 size={14} /> Close
                                  </button>
                                )}
                                {row.source === 'asset' && (
                                  <>
                                    <button
                                      className="btn-ghost px-2.5 py-1.5 text-xs font-semibold text-green-600 hover:bg-green-50"
                                      disabled={busyId === row.key}
                                      onClick={() => decideAsset(row, true)}
                                      title="Confirm the defect — flag the asset and close the report"
                                    >
                                      <CheckCircle2 size={14} /> Confirm
                                    </button>
                                    <button
                                      className="btn-ghost px-2.5 py-1.5 text-xs font-semibold text-ink-500 hover:bg-ink-100"
                                      disabled={busyId === row.key}
                                      onClick={() => decideAsset(row, false)}
                                      title="Dismiss — false report"
                                    >
                                      <X size={14} /> Dismiss
                                    </button>
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </motion.tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-surface-200/60 px-4 py-3"
            page={page}
            pageCount={pageCount}
            onPage={setPage}
            total={total}
            pageSize={pageSize}
          />
        </div>
      )}

      <CloseDefectModal
        open={!!closeFor}
        onClose={() => setCloseFor(null)}
        row={closeFor}
       
        orgName={orgName}
        actor={{ uid: profile?.uid, name: profile?.name }}
      />
    </div>
  )
}
