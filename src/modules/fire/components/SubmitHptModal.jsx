import { useEffect, useRef, useState } from 'react'
import { Gauge, Send, Paperclip, X, TriangleAlert } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Modal, Spinner, Field } from './ui'
import { submitHpt } from '../lib/data'
import { validateHpt, nextHptDate, HPT_RESULT } from '../lib/hpt'
import { readFileAsDataUrl } from '../../../shared/lib/files'
import { safeHref } from '../../../shared/safeUrl'
import { todayISO } from '../../../shared/lib/dates'

/**
 * Record the hydrostatic pressure test for a cylinder whose HPT has come due.
 *
 * This replaces the quotation step for those units, because the two are not the
 * same kind of thing: a quotation is a step towards buying work, an HPT IS the
 * work, and it is the event that clears the unit. What has to be captured is
 * the test — when, by whom, what the certificate says, and crucially whether the
 * cylinder passed.
 *
 * Props: open, onClose, ext, orgId, orgName, actor, onSubmitted?(hpt)
 */
export default function SubmitHptModal({ open, onClose, ext, orgName, actor, onSubmitted }) {
  const [form, setForm] = useState({
    testedOn: '', result: HPT_RESULT.PASS, nextDueOn: '', vendor: '', ref: '', notes: '',
  })
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (!ext) return
    const h = ext.hpt || {}
    const testedOn = h.testedOn || todayISO()
    setForm({
      testedOn,
      result: h.result || HPT_RESULT.PASS,
      // Offered, not imposed: the cycle is the common case and retyping it for
      // every cylinder is how a wrong date gets pasted in.
      nextDueOn: h.nextDueOn || nextHptDate(testedOn),
      vendor: h.vendor || '',
      ref: h.ref || '',
      notes: h.notes || '',
    })
    setFile(h.fileData ? { name: h.fileName || 'certificate', type: h.fileType || '', data: h.fileData } : null)
  }, [ext])

  if (!ext) return null

  const set = (k) => (e) => {
    const v = e.target.value
    setForm((p) => ({
      ...p,
      [k]: v,
      // Keep the suggested next date in step while it is still the suggestion.
      ...(k === 'testedOn' && p.nextDueOn === nextHptDate(p.testedOn) ? { nextDueOn: nextHptDate(v) } : {}),
    }))
  }

  const pickFile = async (f) => {
    if (!f) return
    try {
      setFile({ name: f.name, type: f.type, data: await readFileAsDataUrl(f) })
    } catch (e) {
      toastCaught(e)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const failed = form.result === HPT_RESULT.FAIL

  const submit = async () => {
    const problem = validateHpt(form)
    if (problem) return toast.error(problem)
    setBusy(true)
    try {
      const hpt = await submitHpt(orgName, ext.id, {
        ...form,
        // A failure has no next due date to record; the cylinder is condemned.
        nextDueOn: failed ? '' : form.nextDueOn,
        fileName: file?.name || '',
        fileType: file?.type || '',
        fileData: file?.data || null,
      }, actor?.name)
      toast.success(failed ? 'Failed test recorded — cylinder still flagged' : 'Hydrostatic test recorded')
      onSubmitted?.(hpt)
      onClose?.()
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  const label = ext.serialNo ? `${ext.serialNo} · ${ext.type || ''}` : `${ext.type || ''} ${ext.capacity || ''}`

  return (
    <Modal open={open} onClose={onClose} title="Record hydrostatic test" maxWidth="max-w-lg">
      <div className="ring-1 ring-ink-200 mb-4 flex items-center gap-2 rounded-2xl bg-surface-50 px-3 py-2.5 text-sm text-ink-600 ">
        <Gauge size={16} className="text-ink-400" />
        <span>
          Hydrostatic test for <span className="font-semibold text-ink-800">{label}</span>
          {ext.dateOfNextHPT ? <> — due {ext.dateOfNextHPT}</> : null}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date tested *">
          <input type="date" className="input font-mono" value={form.testedOn} onChange={set('testedOn')} />
        </Field>
        <Field label="Testing agency *">
          <input className="input" value={form.vendor} onChange={set('vendor')} placeholder="Who carried out the test" />
        </Field>
        <Field label="Result *">
          <select className="input" value={form.result} onChange={set('result')}>
            <option value={HPT_RESULT.PASS}>Passed</option>
            <option value={HPT_RESULT.FAIL}>Failed — cylinder condemned</option>
          </select>
        </Field>
        <Field label={failed ? 'Next test due' : 'Next test due *'}>
          <input
            type="date"
            className="input font-mono disabled:opacity-50"
            value={failed ? '' : form.nextDueOn}
            onChange={set('nextDueOn')}
            disabled={failed}
          />
        </Field>
        <Field label="Certificate number">
          <input className="input" value={form.ref} onChange={set('ref')} placeholder="Optional" />
        </Field>
      </div>

      {/* Shown the moment Failed is chosen, because the consequence is the
          opposite of what submitting usually means here: nothing is cleared. */}
      {failed && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl bg-red-50 p-3 text-xs font-semibold text-red-800">
          <TriangleAlert size={15} className="mt-0.5 flex-none" />
          <p>
            A failed test condemns the cylinder. Its due date is left where it is, so this unit
            stays on the list until it is replaced — it will not be marked compliant.
          </p>
        </div>
      )}

      <Field label="Test certificate" className="mt-4">
        {file ? (
          <div className="ring-1 ring-ink-200 flex items-center gap-2 rounded-2xl bg-surface-50 px-3 py-2 ">
            <Paperclip size={15} className="text-ink-400" />
            {file.data ? (
              <a href={safeHref(file.data)} target="_blank" rel="noreferrer" className="truncate text-sm text-ink-700 hover:underline">
                {file.name}
              </a>
            ) : (
              <span className="truncate text-sm text-ink-700">{file.name}</span>
            )}
            <button type="button" onClick={() => setFile(null)} className="ml-auto rounded-lg p-1 text-ink-400 hover:bg-red-50 hover:text-red-600">
              <X size={15} />
            </button>
          </div>
        ) : (
          <label className="btn-ghost inline-flex cursor-pointer text-xs">
            <Paperclip size={14} /> Attach certificate
            <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
          </label>
        )}
      </Field>

      <Field label="Notes" className="mt-4">
        <textarea className="input min-h-[64px]" value={form.notes} onChange={set('notes')} placeholder="Anything worth recording about the test" />
      </Field>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? <Spinner size={16} /> : <><Send size={16} /> Record test</>}
        </button>
      </div>
    </Modal>
  )
}
