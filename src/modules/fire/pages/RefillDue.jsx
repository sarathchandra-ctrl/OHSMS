import { useMemo, useState } from 'react'
import {
  RefreshCw,
  Truck,
  AlertTriangle,
  QrCode,
  Download,
  FileText,
  CheckCircle2,
  Gauge,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState } from '../components/ui'
import ExtinguisherTable from '../components/ExtinguisherTable'
import ReportDefectModal from '../components/ReportDefectModal'
import SubmitQuotationModal from '../components/SubmitQuotationModal'
import SubmitHptModal from '../components/SubmitHptModal'
import ListFilters from '../components/ListFilters'
import { TableSkeleton } from '../components/Skeleton'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { markReceivedByVendor } from '../lib/firestore'
import { hasQuotation } from '../lib/extinguisherLogic'
import { requiredStep, WORKFLOW_STEP } from '../lib/hpt'
import { emptyFilters, applyListFilters } from '../lib/listFilter'
import { exportExtinguishers } from '../lib/exporter'
import { safeHref } from '../../../shared/safeUrl'

export default function RefillDue() {
  const { refillDue, loading } = useFleet()
  const { orgName, profile } = useAuth()
  const today = useMemo(() => new Date(), [])
  const [reportFor, setReportFor] = useState(null)
  const [quoteFor, setQuoteFor] = useState(null)
  const [hptFor, setHptFor] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [filters, setFilters] = useState(emptyFilters())

  const visible = useMemo(() => applyListFilters(refillDue, filters), [refillDue, filters])

  const doExport = () => {
    if (!visible.length) return toast.error('Nothing to export')
    exportExtinguishers(visible, `to-be-refilled-${visible.length}.xlsx`, today)
    toast.success(`Exported ${visible.length} rows`)
  }

  const receive = async (ext) => {
    setBusyId(ext.id)
    try {
      await markReceivedByVendor(orgName, ext.id, profile?.name)
      toast.success('Marked received by vendor — now In Process')
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="To Be Refilled"
        subtitle="Extinguishers due for refill/HPT (within 30 days) or flagged empty / over-pressurized."
        icon={RefreshCw}
      >
        <button className="btn-ghost" onClick={doExport}>
          <Download size={16} /> Export
        </button>
      </PageHeader>

      {refillDue.length > 0 && <ListFilters filters={filters} onChange={setFilters} />}

      {loading ? (
        <TableSkeleton rows={6} cols={7} />
      ) : refillDue.length === 0 ? (
        <EmptyState
          icon={RefreshCw}
          title="Nothing due"
          hint="No extinguishers currently need refilling. 🎉"
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={RefreshCw} title="No matches" hint="Try adjusting the filters above." />
      ) : (
        <ExtinguisherTable
          items={visible}
          today={today}
          renderActions={(ext) => (
            <>
              {/* A cylinder here because its HPT fell due needs the TEST
                  recorded, not a quotation raised. The two are different events:
                  a quotation is a step towards buying work, an HPT is the work,
                  and passing it is what clears the unit from this list. Where
                  both a refill and an HPT are due the test takes precedence —
                  the cylinder cannot be refilled until it has passed. */}
              {requiredStep(ext, today) === WORKFLOW_STEP.HPT ? (
                <button
                  className="btn bg-violet-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                  onClick={() => setHptFor(ext)}
                  title={`Hydrostatic test due ${ext.dateOfNextHPT || ''} — record the test and its certificate`}
                >
                  <Gauge size={14} /> Submit HPT
                </button>
              ) : hasQuotation(ext) ? (
                <button
                  className="btn-soft px-2.5 py-1.5 text-xs"
                  disabled={busyId === ext.id}
                  onClick={() => receive(ext)}
                  title="Quotation submitted — move to In Process"
                >
                  <Truck size={14} /> Received by vendor
                </button>
              ) : (
                <button
                  className="btn bg-brand-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                  onClick={() => setQuoteFor(ext)}
                  title="Submit a vendor quotation before this can move forward"
                >
                  <FileText size={14} /> Submit quotation
                </button>
              )}

              {/* A recorded failure is the one outcome that leaves the unit
                  here, so it is stated on the row rather than buried. */}
              {ext.hpt?.result === 'fail' && (
                <span
                  className="chip bg-red-50 text-red-700"
                  title={`Failed on ${ext.hpt.testedOn || ''} · ${ext.hpt.vendor || ''}`}
                >
                  <AlertTriangle size={12} /> HPT failed
                </span>
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
                title="Report defect"
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
    </div>
  )
}
