import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { format } from 'date-fns'
import { Wrench, CheckCircle2, Download, QrCode } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Badge } from '../components/ui'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import ListFilters from '../components/ListFilters'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { resolveDefects } from '../lib/data'
import { hasQuotation } from '../lib/extinguisherLogic'
import { isHptOverdue, HPT_BLOCKS_RESOLVE, QUOTATION_BLOCKS_RESOLVE, resolveBlockReason } from '../lib/hpt'
import { exportSiteDefects } from '../lib/exporter'
import { summariseDefectsBySite } from '../lib/siteDefectSummary'
import { toDate } from '../lib/extinguisherLogic'
import { emptyFilters, applyListFilters } from '../lib/listFilter'
import { DEFECT_BY_KEY, REGION_COLORS } from '../lib/constants'

/**
 * Records of physical-defect reports (approved).
 *  - mode="open"   → defect still active on the unit
 *  - mode="closed" → defect resolved (or unit refilled-away / deleted)
 * Filterable by every creation field except dates.
 */
export default function PhysicalDefectLog({ mode = 'open' }) {
  const fleet = useFleet()
  const { orgName, profile, isManager } = useAuth()
  const rows = mode === 'open' ? fleet.physicalOpen : fleet.physicalClosed

  const [filters, setFilters] = useState(emptyFilters())
  const [busyId, setBusyId] = useState(null)

  const filtered = useMemo(() => applyListFilters(rows, filters), [rows, filters])
  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filtered)

  const isClosed = mode === 'closed'
  const canResolve = !isClosed && isManager

  // Close a single reported defect by removing just that type from the unit.
  const resolveOne = async (r) => {
    const ext = fleet.extinguishers.find((e) => e.id === r.extId)
    if (!ext) return toast.error('Unit not found')
    const block = resolveBlockReason(ext)
    if (block) return toast.error(block)
    setBusyId(r.id)
    try {
      const remaining = (ext.physicalDefects || []).filter((d) => d !== r.defectType)
      await resolveDefects(orgName, r.extId, remaining, profile?.name)
      toast.success(`Resolved: ${r.defectLabel}`)
    } catch (e) {
      toastCaught(e, 'Could not resolve the defect')
    } finally {
      setBusyId(null)
    }
  }
  const title = isClosed ? 'Physical Defects (Closed)' : 'Physical Defects (Open)'
  const fileBase = isClosed ? 'physical-defects-closed' : 'physical-defects-open'

  const fmt = (v) => {
    const d = toDate(v)
    return d ? format(d, 'dd MMM yyyy') : '—'
  }

  // Exports every match, not the page on screen — the workbook is the whole
  // filtered set so a site summary is never cut off at the page boundary.
  const doExport = () => {
    if (!filtered.length) return toast.error('Nothing to export')
    // Site-wise first — how many defects each site has, of what kinds, and how
    // to get there — with the per-unit rows kept on a second sheet.
    const bySite = summariseDefectsBySite(filtered, fleet.siteInventory)
    exportSiteDefects(bySite, filtered, `${fileBase}-${bySite.length}-sites.xlsx`)
    toast.success(`Exported ${filtered.length} defects across ${bySite.length} site${bySite.length === 1 ? '' : 's'}`)
  }

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={
          isClosed
            ? 'Approved physical-defect reports that have since been resolved.'
            : 'Approved physical-defect reports still active on their units.'
        }
        icon={isClosed ? CheckCircle2 : Wrench}
      >
        <button className="btn-ghost" onClick={doExport}><Download size={16} /> Export</button>
      </PageHeader>

      {/* Filters (no dates) */}
      <ListFilters
        filters={filters}
        onChange={setFilters}
        showDefect
        searchPlaceholder="Search serial, center or type…"
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={isClosed ? CheckCircle2 : Wrench}
          title={rows.length ? 'No matches' : isClosed ? 'No resolved defects yet' : 'No open physical defects'}
          hint={rows.length ? 'Try adjusting your filters.' : isClosed ? 'Resolved physical defects will be recorded here.' : 'Approved physical defects appear here. 🛠️'}
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3">Serial / Type</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Region</th>
                  <th className="px-4 py-3">Center</th>
                  <th className="px-4 py-3">Defect</th>
                  <th className="px-4 py-3">Reported</th>
                  <th className="px-4 py-3">{isClosed ? 'Resolved' : 'Approved'}</th>
                  <th className="px-4 py-3">Action By</th>
                  <th className="px-4 py-3 text-right">QR</th>
                  {canResolve && <th className="px-4 py-3 text-right">Resolve</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((r, i) => {
                  const color = DEFECT_BY_KEY[r.defectType]?.color || '#64748b'
                  const ext = fleet.extinguishers.find((e) => e.id === r.extId)
                  const hptDue = isHptOverdue(ext)
                  const needsQuote = !hptDue && !hasQuotation(ext)
                  return (
                    <motion.tr
                      key={r.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.02, 0.4) }}
                      className="hover:bg-surface-100/50"
                      style={{ boxShadow: `inset 4px 0 0 ${color}` }}
                    >
                      <td className="px-4 py-3">
                        <div className="font-bold text-ink-900">{r.serialNo || '—'}</div>
                        <div className="text-xs text-ink-500">{r.type}{r.capacity ? ` · ${r.capacity}` : ''}</div>
                      </td>
                      <td className="px-4 py-3 text-ink-700">{r.entity || '—'}</td>
                      <td className="px-4 py-3">
                        {r.region ? <Badge color={REGION_COLORS[r.region] || '#64748b'}>{r.region}</Badge> : <span className="text-ink-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-ink-700">{r.centerName}{r.deleted && <span className="ml-1 text-xs text-red-500">(deleted)</span>}</td>
                      <td className="px-4 py-3"><Badge color={color}>{r.defectLabel}</Badge></td>
                      <td className="px-4 py-3 text-ink-600">{fmt(r.reportedAt)}</td>
                      <td className="px-4 py-3 text-ink-600">{fmt(r.reviewedAt)}</td>
                      <td className="px-4 py-3">
                        {r.lastActionBy ? (
                          <div className="leading-tight">
                            <div className="font-medium text-ink-800">{r.lastActionBy}</div>
                            {r.lastAction && <div className="text-[11px] text-ink-400">{r.lastAction}</div>}
                          </div>
                        ) : <span className="text-ink-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {r.qrToken ? (
                          <a className="btn-ghost px-2.5 py-1.5 text-xs" href={`/qr/${r.qrToken}`} target="_blank" rel="noreferrer" title="Public QR">
                            <QrCode size={14} />
                          </a>
                        ) : <span className="text-ink-300">—</span>}
                      </td>
                      {canResolve && (
                        <td className="px-4 py-3 text-right">
                          {r.deleted ? (
                            <span className="text-ink-300">—</span>
                          ) : hptDue ? (
                            <span className="text-xs font-semibold text-violet-700" title={HPT_BLOCKS_RESOLVE}>
                              HPT due
                            </span>
                          ) : needsQuote ? (
                            <span className="text-xs font-semibold text-cyan-800" title={QUOTATION_BLOCKS_RESOLVE}>
                              Needs quotation
                            </span>
                          ) : (
                            <button
                              className="btn-ghost px-2.5 py-1.5 text-xs font-semibold text-green-600 hover:bg-green-50"
                              disabled={busyId === r.id}
                              onClick={() => resolveOne(r)}
                              title="Mark this defect as resolved"
                            >
                              <CheckCircle2 size={14} /> Resolve
                            </button>
                          )}
                        </td>
                      )}
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
    </div>
  )
}
