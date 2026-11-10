import { useMemo, useRef, useState } from 'react'
import { Truck, CheckCircle2, QrCode, Download, PackageCheck, Paperclip, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Spinner, Field } from '../components/ui'
import ExtinguisherTable from '../components/ExtinguisherTable'
import ListFilters from '../components/ListFilters'
import { TableSkeleton } from '../components/Skeleton'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { markRefilledAndClosed } from '../lib/data'
import { hptDateUnchanged, validateRefilledClosed, validateRefilledHpt } from '../lib/receive'
import ReceiveFromVendorModal from '../components/ReceiveFromVendorModal'
import { emptyFilters, applyListFilters } from '../lib/listFilter'
import { exportExtinguishers } from '../lib/exporter'
import { isFutureDate, todayISO } from '../../../shared/lib/dates'
import { readFileAsDataUrl } from '../../../shared/lib/files'

export default function InProcess() {
  const { inProcess, loading } = useFleet()
  const { orgName, profile } = useAuth()
  const today = useMemo(() => new Date(), [])
  const [closing, setClosing] = useState(null) // ext being closed
  const [receiving, setReceiving] = useState(null)
  const [dates, setDates] = useState({ dateOfNextRefill: '', dateOfNextHPT: '' })
  const [certificate, setCertificate] = useState({ testedOn: '', vendor: '', file: null })
  const [busy, setBusy] = useState(false)
  const [filters, setFilters] = useState(emptyFilters())
  const fileInputRef = useRef(null)

  const visible = useMemo(() => applyListFilters(inProcess, filters), [inProcess, filters])

  const doExport = () => {
    if (!visible.length) return toast.error('Nothing to export')
    exportExtinguishers(visible, `in-process-${visible.length}.xlsx`, today)
    toast.success(`Exported ${visible.length} rows`)
  }

  const openClose = (ext) => {
    setClosing(ext)
    // A date already in the future is not a new test. Prefilling it means a
    // refill close that leaves the hydrostatic date alone does not ask for a
    // certificate. An overdue date is left blank: typing a later one is the
    // claim that needs the certificate.
    const refill = ext?.dateOfNextRefill || ''
    const hpt = ext?.dateOfNextHPT || ''
    setDates({
      dateOfNextRefill: isFutureDate(refill) ? refill : '',
      dateOfNextHPT: isFutureDate(hpt) ? hpt : '',
    })
    setCertificate({ testedOn: todayISO(), vendor: '', file: null })
  }

  const hptMoved = !hptDateUnchanged(closing?.dateOfNextHPT, dates.dateOfNextHPT)

  const pickCertificate = async (f) => {
    if (!f) return
    try {
      const data = await readFileAsDataUrl(f)
      setCertificate((c) => ({ ...c, file: { name: f.name, type: f.type, data } }))
    } catch (e) {
      toastCaught(e)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const confirmClose = async () => {
    const dateError = validateRefilledClosed(dates)
    if (dateError) return toast.error(dateError)
    const certificatePayload = {
      testedOn: certificate.testedOn,
      vendor: certificate.vendor,
      fileName: certificate.file?.name || '',
      fileType: certificate.file?.type || '',
      fileData: certificate.file?.data || null,
    }
    const certError = validateRefilledHpt(closing?.dateOfNextHPT, {
      dateOfNextHPT: dates.dateOfNextHPT,
      certificate: certificatePayload,
    })
    if (certError) return toast.error(certError)
    setBusy(true)
    try {
      await markRefilledAndClosed(
        orgName,
        closing.id,
        { ...dates, certificate: hptMoved ? certificatePayload : null },
        profile?.name,
      )
      toast.success('Refilled & closed — dates updated, defects cleared')
      setClosing(null)
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="In Process of Refilling"
        subtitle="Units currently with the vendor. Mark received when one comes back — that leaves the hydrostatic date where it is. Refilled & closed records a new hydrostatic-test date only with its certificate."
        icon={Truck}
      >
        <button className="btn-ghost" onClick={doExport}><Download size={16} /> Export</button>
      </PageHeader>

      {inProcess.length > 0 && <ListFilters filters={filters} onChange={setFilters} />}

      {loading ? (
        <TableSkeleton rows={5} cols={7} />
      ) : inProcess.length === 0 ? (
        <EmptyState icon={Truck} title="None in process" hint="Mark a due extinguisher as received by vendor to start." />
      ) : visible.length === 0 ? (
        <EmptyState icon={Truck} title="No matches" hint="Try adjusting the filters above." />
      ) : (
        <ExtinguisherTable
          items={visible}
          today={today}
          showActionBy
          renderActions={(ext) => (
            <>
              <button className="btn bg-green-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110" onClick={() => setReceiving(ext)}>
                <PackageCheck size={14} /> Received
              </button>
              <button className="btn bg-green-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110" onClick={() => openClose(ext)}>
                <CheckCircle2 size={14} /> Refilled & closed
              </button>
              <a className="btn-ghost px-2.5 py-1.5 text-xs" href={`/qr/${ext.qrToken}`} target="_blank" rel="noreferrer" title="Public QR">
                <QrCode size={14} />
              </a>
            </>
          )}
        />
      )}

      <ReceiveFromVendorModal
        open={!!receiving}
        onClose={() => setReceiving(null)}
        ext={receiving}
       
        orgName={orgName}
        actorName={profile?.name}
      />

      <Modal open={!!closing} onClose={() => setClosing(null)} title="Refilled & Closed">
        <p className="mb-4 text-sm text-ink-600">
          Confirm the refill of <strong>{closing?.serialNo || closing?.type}</strong> and set its new
          due dates. Any active defects will be cleared and the unit reactivated. A hydrostatic date
          that differs from the one on the unit needs the test certificate.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="New Next Refill date">
            <input type="date" className="input" value={dates.dateOfNextRefill} onChange={(e) => setDates({ ...dates, dateOfNextRefill: e.target.value })} />
          </Field>
          <Field label="New Next HPT date">
            <input type="date" className="input" value={dates.dateOfNextHPT} onChange={(e) => setDates({ ...dates, dateOfNextHPT: e.target.value })} />
          </Field>
        </div>
        {hptMoved && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date tested">
              <input type="date" className="input" value={certificate.testedOn} onChange={(e) => setCertificate({ ...certificate, testedOn: e.target.value })} />
            </Field>
            <Field label="Testing agency">
              <input className="input" value={certificate.vendor} onChange={(e) => setCertificate({ ...certificate, vendor: e.target.value })} placeholder="Who carried out the test" />
            </Field>
            <Field label="Test certificate" className="sm:col-span-2">
              {certificate.file ? (
                <div className="ring-1 ring-ink-200 flex items-center gap-2 rounded-2xl bg-surface-50 px-3 py-2">
                  <Paperclip size={15} className="text-ink-400" />
                  <span className="truncate text-sm text-ink-700">{certificate.file.name}</span>
                  <button type="button" onClick={() => setCertificate({ ...certificate, file: null })} className="ml-auto rounded-lg p-1 text-ink-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove certificate">
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <label className="btn-ghost inline-flex cursor-pointer text-xs">
                  <Paperclip size={14} /> Attach certificate
                  <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => pickCertificate(e.target.files?.[0])} />
                </label>
              )}
            </Field>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setClosing(null)}>Cancel</button>
          <button className="btn bg-green-600 text-white hover:brightness-110" onClick={confirmClose} disabled={busy}>
            {busy ? <Spinner size={18} /> : (<><CheckCircle2 size={16} /> Confirm & close</>)}
          </button>
        </div>
      </Modal>
    </div>
  )
}
