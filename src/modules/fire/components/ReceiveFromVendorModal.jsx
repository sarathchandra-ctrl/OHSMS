import { useEffect, useState } from 'react'
import { PackageCheck } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Modal, Spinner, Field } from './ui'
import { markReceivedFromVendor } from '../lib/firestore'
import { validateReceive } from '../lib/receive'
import { todayISO } from '../../../shared/lib/dates'

/**
 * Mark an in-process extinguisher received back from the vendor.
 * The next refill date is required: without it the unit returns to Active
 * and is immediately due again, which is the list it was sent out to leave.
 */
export default function ReceiveFromVendorModal({ open, onClose, ext, orgName, actorName }) {
  const [receivedOn, setReceivedOn] = useState('')
  const [dateOfNextRefill, setDateOfNextRefill] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setReceivedOn(todayISO())
    setDateOfNextRefill('')
    setBusy(false)
  }, [open, ext])

  if (!ext) return null

  const confirm = async () => {
    const error = validateReceive({ receivedOn, dateOfNextRefill })
    if (error) return toast.error(error)
    setBusy(true)
    try {
      await markReceivedFromVendor(
        orgName,
        ext.id,
        { receivedOn, dateOfNextRefill },
        actorName
      )
      toast.success('Received — back in service')
      onClose?.()
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  const label = ext.serialNo || ext.type || 'this unit'

  return (
    <Modal open={open} onClose={onClose} title="Received from vendor">
      <p className="mb-4 text-sm text-ink-600">
        Record the day <strong>{label}</strong> came back and the next refill date the recharge
        established. The unit returns to Active. Empty and over-pressure defects from this refill
        are closed with it.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Received on">
          <input
            type="date"
            className="input"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </Field>
        <Field label="Next refill date">
          <input
            type="date"
            className="input"
            value={dateOfNextRefill}
            onChange={(e) => setDateOfNextRefill(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn bg-green-600 text-white hover:brightness-110"
          onClick={confirm}
          disabled={busy}
        >
          {busy ? (
            <Spinner size={18} />
          ) : (
            <>
              <PackageCheck size={16} /> Confirm received
            </>
          )}
        </button>
      </div>
    </Modal>
  )
}
