import { useMemo, useState } from 'react'
import {
  Wrench,
  AlertTriangle,
  QrCode,
  CheckCircle2,
  Download,
  FileText,
  Gauge,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Spinner } from '../components/ui'
import ExtinguisherTable from '../components/ExtinguisherTable'
import ReportDefectModal from '../components/ReportDefectModal'
import SubmitQuotationModal from '../components/SubmitQuotationModal'
import SubmitHptModal from '../components/SubmitHptModal'
import ListFilters from '../components/ListFilters'
import { TableSkeleton } from '../components/Skeleton'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { resolveDefects } from '../lib/data'
import { emptyFilters, applyListFilters } from '../lib/listFilter'
import { exportSiteDefects } from '../lib/exporter'
import { summariseDefectsBySite } from '../lib/siteDefectSummary'
import { deriveStatus, hasQuotation } from '../lib/extinguisherLogic'
import { requiredStep, WORKFLOW_STEP } from '../lib/hpt'
import { DEFECT_BY_KEY, PHYSICAL_DEFECT_KEYS } from '../lib/constants'
import { safeHref } from '../../../shared/safeUrl'
import { readableOnTint } from '../../../shared/lib/contrast'

export default function PhysicalDefects() {
  const { physicalDefects, siteInventory, loading } = useFleet()
  const { orgName, profile } = useAuth()
  const today = useMemo(() => new Date(), [])
  const [reportFor, setReportFor] = useState(null)
  const [quoteFor, setQuoteFor] = useState(null)
  const [hptFor, setHptFor] = useState(null)
  const [resolving, setResolving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [filters, setFilters] = useState(emptyFilters())

  const visible = useMemo(
    () => applyListFilters(physicalDefects, filters),
    [physicalDefects, filters]
  )

  const doExport = () => {
    if (!visible.length) return toast.error('Nothing to export')
    // This page lists units, and one unit can carry several defects. Expanding
    // them first is what makes "No. of Defects" a defect count rather than a
    // unit count.
    const defectRows = visible.flatMap((ext) =>
      (ext.physicalDefects || []).map((key) => ({
        centerName: ext.centerName,
        entity: ext.entity,
        region: ext.region,
        defectLabel: DEFECT_BY_KEY[key]?.label || key,
      }))
    )
    const bySite = summariseDefectsBySite(defectRows, siteInventory)
    exportSiteDefects(bySite, visible, `physical-defects-${bySite.length}-sites.xlsx`)
    toast.success(
      `Exported ${defectRows.length} defects across ${bySite.length} site${bySite.length === 1 ? '' : 's'}`
    )
  }

  const physical = (ext) => deriveStatus(ext, today).physicalDefects

  const confirmResolve = async () => {
    setBusy(true)
    try {
      // keep any refill-type defects, clear only physical ones
      const remaining = (resolving.physicalDefects || []).filter(
        (k) => !PHYSICAL_DEFECT_KEYS.includes(k)
      )
      await resolveDefects(orgName, resolving.id, remaining, profile?.name)
      toast.success('Physical defects resolved')
      setResolving(null)
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="Physical Defects"
        subtitle="Units with PIN, stand, hose, or handle damage requiring physical repair."
        icon={Wrench}
      >
        <button className="btn-ghost" onClick={doExport}>
          <Download size={16} /> Export
        </button>
      </PageHeader>

      {physicalDefects.length > 0 && <ListFilters filters={filters} onChange={setFilters} />}

      {loading ? (
        <TableSkeleton rows={5} cols={7} />
      ) : physicalDefects.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No physical defects"
          hint="All units are physically intact. 🛠️"
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={Wrench} title="No matches" hint="Try adjusting the filters above." />
      ) : (
        <ExtinguisherTable
          items={visible}
          today={today}
          renderActions={(ext) => (
            <>
              {/* A unit whose hydrostatic test is due is asked for the TEST, not
                  for a quotation — the same branch RefillDue makes, for the same
                  reason, and it belongs here too.

                  An HPT can CONDEMN the cylinder. Raising a quotation to repair
                  a defect on a unit that may be about to fail its pressure test
                  is money spent on a cylinder that cannot legally return to
                  service either way, and worse, resolving the defect afterwards
                  reads as "this unit is fine" while the test is still
                  outstanding. The test comes first and settles the question. */}
              {requiredStep(ext, today) === WORKFLOW_STEP.HPT ? (
                <button
                  className="btn bg-violet-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                  onClick={() => setHptFor(ext)}
                  title={`Hydrostatic test due ${ext.dateOfNextHPT || ''} — record the test and its certificate before resolving`}
                >
                  <Gauge size={14} /> Submit HPT
                </button>
              ) : hasQuotation(ext) ? (
                <button
                  className="btn bg-green-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                  onClick={() => setResolving(ext)}
                  title="Quotation submitted — resolve defects"
                >
                  <CheckCircle2 size={14} /> Resolve
                </button>
              ) : (
                <button
                  className="btn bg-brand-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                  onClick={() => setQuoteFor(ext)}
                  title="Submit a vendor quotation before resolving"
                >
                  <FileText size={14} /> Submit quotation
                </button>
              )}
              {hasQuotation(ext) &&
                (ext.quotation?.fileData || ext.quotation?.fileUrl ? (
                  <a
                    href={safeHref(ext.quotation.fileData || ext.quotation.fileUrl)}
                    target="_blank"
                    rel="noreferrer"
                    className="chip bg-cyan-50 text-cyan-700 hover:underline"
                    title={`Quoted ${ext.quotation?.amount ?? ''} · ${ext.quotation?.vendor || ''} — view document`}
                  >
                    <CheckCircle2 size={12} /> Quoted · View
                  </a>
                ) : (
                  <span
                    className="chip bg-cyan-50 text-cyan-700"
                    title={`Quoted ${ext.quotation?.amount ?? ''} · ${ext.quotation?.vendor || ''}`}
                  >
                    <CheckCircle2 size={12} /> Quoted
                  </span>
                ))}
              <button
                className="btn-ghost px-2.5 py-1.5 text-xs"
                onClick={() => setReportFor(ext)}
                title="Report another defect"
              >
                <AlertTriangle size={14} />
              </button>
              <a
                className="btn-ghost px-2.5 py-1.5 text-xs"
                href={`/qr/${ext.qrToken}`}
                target="_blank"
                rel="noreferrer"
                title="Public QR"
              >
                <QrCode size={14} />
              </a>
            </>
          )}
        />
      )}

      <ReportDefectModal
        open={!!reportFor}
        onClose={() => setReportFor(null)}
        ext={reportFor}
       
        reporter={{ uid: profile?.uid, name: profile?.name }}
      />

      <SubmitQuotationModal
        open={!!quoteFor}
        onClose={() => setQuoteFor(null)}
        ext={quoteFor}
       
        orgName={orgName}
        actor={{ uid: profile?.uid, name: profile?.name }}
      />

      <SubmitHptModal
        open={!!hptFor}
        onClose={() => setHptFor(null)}
        ext={hptFor}
       
        orgName={orgName}
        actor={{ uid: profile?.uid, name: profile?.name }}
      />

      <Modal open={!!resolving} onClose={() => setResolving(null)} title="Resolve physical defects">
        {resolving && (
          <>
            <p className="text-sm text-ink-600">
              Mark these physical defects on <strong>{resolving.serialNo || resolving.type}</strong>{' '}
              as repaired?
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {physical(resolving).map((k) => (
                <span
                  key={k}
                  className="chip"
                  style={{
                    backgroundColor: `${DEFECT_BY_KEY[k].color}1a`,
                    color: readableOnTint(DEFECT_BY_KEY[k].color),
                  }}
                >
                  {DEFECT_BY_KEY[k].label}
                </span>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setResolving(null)}>
                Cancel
              </button>
              <button
                className="btn bg-green-600 text-white hover:brightness-110"
                onClick={confirmResolve}
                disabled={busy}
              >
                {busy ? <Spinner size={18} /> : 'Mark resolved'}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
