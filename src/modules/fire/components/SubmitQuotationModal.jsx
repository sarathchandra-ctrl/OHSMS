import { useEffect, useRef, useState } from 'react'
import { FileText, Send, Paperclip, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Modal, Spinner, Field } from './ui'
import { submitQuotation } from '../lib/data'
import { readFileAsDataUrl, MAX_ATTACHMENT_BYTES } from '../../../shared/lib/files'
import { formatSize } from '../../../shared/storage'
import { safeHref } from '../../../shared/safeUrl'
import { todayISO } from '../../../shared/lib/dates'

/**
 * Submit a vendor quotation for a defective / refill-due extinguisher. A
 * quotation must exist before the item can progress (received-by-vendor /
 * resolve). Reuses submitQuotation, which stores it on the extinguisher doc.
 *
 * Props: open, onClose, ext, orgId, orgName, actor, onSubmitted?(quotation)
 */
export default function SubmitQuotationModal({ open, onClose, ext, orgName, actor, onSubmitted }) {
  const [form, setForm] = useState({ amount: '', vendor: '', ref: '', notes: '' })
  // Attached document: { name, type, data(base64) }. null = none.
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (ext) {
      const q = ext.quotation || {}
      setForm({
        amount: q.amount ? String(q.amount) : '',
        vendor: q.vendor || '',
        ref: q.ref || '',
        notes: q.notes || '',
      })
      // Prefill an existing attachment so re-submitting keeps it unless replaced.
      setFile(q.fileData ? { name: q.fileName || 'quotation', type: q.fileType || '', data: q.fileData } : null)
    }
  }, [ext])

  if (!ext) return null
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const pickFile = async (f) => {
    if (!f) return
    try {
      const data = await readFileAsDataUrl(f)
      setFile({ name: f.name, type: f.type, data })
    } catch (e) {
      toastCaught(e)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const submit = async () => {
    if (!form.amount || Number(form.amount) <= 0) return toast.error('Enter a valid quotation amount')
    if (!form.vendor.trim()) return toast.error('Vendor is required')
    setBusy(true)
    try {
      const payload = {
        ...form,
        fileName: file?.name || '',
        fileType: file?.type || '',
        fileData: file?.data || null,
      }
      await submitQuotation(orgName, ext.id, payload, actor?.name)
      toast.success('Quotation submitted')
      onSubmitted?.({
        amount: Number(form.amount) || 0,
        vendor: form.vendor,
        ref: form.ref,
        notes: form.notes,
        fileName: payload.fileName,
        fileType: payload.fileType,
        fileData: payload.fileData,
        submittedAt: todayISO(),
        submittedBy: actor?.name || '',
      })
      onClose?.()
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  const label = ext.serialNo ? `${ext.serialNo} · ${ext.type || ''}` : `${ext.type || ''} ${ext.capacity || ''}`

  return (
    <Modal open={open} onClose={onClose} title="Submit quotation" maxWidth="max-w-lg">
      <div className="ring-1 ring-ink-200 mb-4 flex items-center gap-2 rounded-2xl bg-surface-50 px-3 py-2.5 text-sm text-ink-600 ">
        <FileText size={16} className="text-ink-400" />
        <span>Quotation for <span className="font-semibold text-ink-800">{label}</span> — required before it can move to the next step.</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount *">
          <input type="number" min="0" step="any" className="input" value={form.amount} onChange={set('amount')} placeholder="0.00" />
        </Field>
        <Field label="Vendor *">
          <input className="input" value={form.vendor} onChange={set('vendor')} placeholder="Vendor name" />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Reference no.">
          <input className="input" value={form.ref} onChange={set('ref')} placeholder="Quote / PO reference (optional)" />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Notes">
          <textarea className="input min-h-[72px]" value={form.notes} onChange={set('notes')} placeholder="Scope, terms, anything relevant…" />
        </Field>
      </div>

      <div className="mt-4">
        <label htmlFor="quotation-file" className="label">Quotation document (optional)</label>
        <input id="quotation-file"
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        {file ? (
          <div className="ring-1 ring-ink-200 flex items-center gap-2 rounded-2xl bg-surface-50 px-3 py-2.5 text-sm ">
            <Paperclip size={15} className="shrink-0 text-ink-400" />
            <a
              href={safeHref(file.data)}
              target="_blank"
              rel="noreferrer"
              className="flex-1 truncate font-medium text-brand-700 hover:underline"
              title="Open attached document"
            >
              {file.name}
            </a>
            <button
              type="button"
              className="rounded-lg p-1 text-ink-400 hover:bg-surface-100 hover:text-ink-700"
              onClick={() => setFile(null)}
              title="Remove file"
            >
              <X size={15} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-ghost w-full justify-center"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={15} /> Attach PDF or image
          </button>
        )}
        <p className="mt-1 text-xs text-ink-400">
          PDF or image, up to {formatSize(MAX_ATTACHMENT_BYTES)}.
        </p>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? <Spinner size={18} /> : (<><Send size={16} /> Submit quotation</>)}
        </button>
      </div>
    </Modal>
  )
}
