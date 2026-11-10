import { useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Send } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Modal, Spinner, Field } from './ui'
import { ASSET_DEFECTS, OTHER_DEFECT, REPORTER_ROLES } from '../lib/constants'
import { createAssetReport } from '../lib/data'

/**
 * Report a defect against an AED, a FAS device or a stretcher from a public QR
 * scan.
 *
 * Separate from ReportDefectModal because the two are not the same sheet: an
 * extinguisher defect is a keyed option that decides whether the unit goes for
 * refilling or onto the physical-defect list, whereas an AED, panel or
 * stretcher fault is free of that lifecycle — approving one simply takes the
 * asset out of service. Sharing a component would mean a mode flag threaded
 * through every field.
 *
 * Props: open, onClose, asset (the public QR mirror doc),
 *        kind ('aed' | 'fas' | 'stretcher')
 */
const KIND_NOUN = { aed: 'AED', fas: 'FAS device', stretcher: 'Stretcher' }

export default function ReportAssetDefectModal({ open, onClose, asset, kind }) {
  const [selected, setSelected] = useState('')
  const [note, setNote] = useState('')
  const [role, setRole] = useState('')
  const [busy, setBusy] = useState(false)

  if (!asset) return null
  const options = ASSET_DEFECTS[kind] || []
  // Falls back to the kind's own noun rather than "AED", which is what an
  // `x === 'fas' ? … : 'AED'` would have called a stretcher.
  const label = asset.label || KIND_NOUN[kind] || 'asset'

  const needsNote = selected === OTHER_DEFECT

  const submit = async () => {
    if (!selected) return toast.error('Select what is wrong')
    if (needsNote && !note.trim()) return toast.error('Describe the problem in the note')
    if (!role) return toast.error('Select who is reporting')
    setBusy(true)
    try {
      await createAssetReport({
        assetKind: kind,
        assetRefId: asset.assetRefId,
        assetLabel: label,
        defect: selected,
        token: asset.token,
        reporterRole: role,
        note,
      })
      toast.success('Defect reported — pending approval')
      setSelected('')
      setNote('')
      setRole('')
      onClose?.()
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Report a defect">
      <div className="mb-4 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
        <AlertTriangle size={16} />
        <span>Reporting for <strong>{label}</strong>. This will await portal approval.</span>
      </div>

      <p className="label">What is wrong?</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((d) => {
          const active = selected === d
          return (
            <motion.button
              key={d}
              type="button"
              whileTap={{ scale: 0.96 }}
              onClick={() => setSelected(d)}
              className={`rounded-xl border-2 px-3 py-3 text-left text-sm font-semibold transition ${
                active ? 'border-transparent bg-red-600 text-white shadow-card' : 'border-ink-200 text-ink-700 hover:border-ink-300'
              }`}
            >
              {d}
            </motion.button>
          )
        })}
      </div>

      <Field label="Reported by *" className="mt-4">
        <select className="input" value={role} onChange={(e) => setRole(e.target.value)} required>
          <option value="" disabled>Select who is reporting…</option>
          {REPORTER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </Field>

      <div className="mt-4">
        <label className="label">{needsNote ? 'Describe the problem *' : 'Note (optional)'}</label>
        <textarea
          className="input min-h-[72px]"
          placeholder="Describe what you observed…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? <Spinner size={18} /> : (<><Send size={16} /> Submit report</>)}
        </button>
      </div>
    </Modal>
  )
}
