import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Upload, X, Paperclip, Link2, Loader2, Video } from 'lucide-react'
import { Button, Input, Field } from '../../../shared/ui'
import { putFile, MAX_UPLOAD_BYTES, formatSize } from '../../../shared/storage'
import { safeHref } from '../../../shared/safeUrl'
import { attachmentShape, referenceHref, describeReference, ATTACHMENT_KINDS } from '../lib/attachments'

/**
 * Attach evidence to an escalation.
 *
 * Uploads go through the shared storage seam, so they land in Cloud Storage
 * when it is configured and fail loudly rather than silently shrinking to a
 * base64 blob in the document — a CCTV clip stored inline would blow the 1 MiB
 * document limit and take the whole escalation down with it.
 *
 * For CCTV the component also accepts a REFERENCE. Video routinely exceeds the
 * upload ceiling, and the alternative to a reference is not a smaller file, it
 * is no record at all.
 */
export default function AttachmentField({ kind, value = [], onChange, disabled = false, actor }) {
  const cfg = ATTACHMENT_KINDS[kind]
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [ref, setRef] = useState({ cameraRef: '', recordedAt: '', location: '', note: '' })
  const [showRef, setShowRef] = useState(false)

  const add = (a) => onChange([...(value || []), attachmentShape(a)])
  const remove = (id) => onChange(value.filter((a) => a.id !== id))

  const onPick = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setBusy(true)
    try {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) {
          // Say what to do instead, not just that it failed. For CCTV that is
          // the reference; for an ethics report it is a smaller export.
          toast.error(
            `${f.name} is ${formatSize(f.size)} — the limit is ${formatSize(MAX_UPLOAD_BYTES)}.` +
            (cfg.allowsReference ? ' Add it as a reference instead.' : '')
          )
          continue
        }
        const stored = await putFile(`escalation-${kind}`, f, f.name)
        if (!stored) {
          toast.error(`${f.name} could not be uploaded — file storage may not be enabled.`)
          continue
        }
        add({
          ...stored,
          mode: 'file',
          addedAt: new Date().toISOString(),
          addedBy: actor?.name || '',
        })
      }
    } catch (err) {
      toastCaught(err, 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const addReference = () => {
    if (!ref.cameraRef.trim() && !ref.location.trim() && !ref.note.trim()) {
      return toast.error('Name the camera, paste a link, or say where the footage is')
    }
    add({ ...ref, mode: 'reference', addedAt: new Date().toISOString(), addedBy: actor?.name || '' })
    setRef({ cameraRef: '', recordedAt: '', location: '', note: '' })
    setShowRef(false)
  }

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">{cfg.label}</span>
          <p className="text-xs text-ink-500">{cfg.hint}</p>
        </div>
        <div className="flex gap-1.5">
          {cfg.allowsReference && (
            <Button variant="ghost" className="px-2.5 py-1 text-xs" icon={Link2}
              onClick={() => setShowRef((s) => !s)} disabled={disabled}>
              Reference
            </Button>
          )}
          <Button variant="ghost" className="px-2.5 py-1 text-xs" icon={busy ? Loader2 : Upload}
            onClick={() => inputRef.current?.click()} disabled={disabled || busy}>
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </div>

      <input ref={inputRef} type="file" multiple accept={cfg.accept} className="hidden" onChange={onPick} />

      {/* The reference form. Camera and time are what still work when a link
          rots, so they come first and the link is optional. */}
      {showRef && (
        <div className="mb-2 grid grid-cols-1 gap-2 rounded-xl bg-ink-50 p-3 sm:grid-cols-2">
          <Field label="Camera" htmlFor="attcam" hint="Which camera holds it">
            <Input id="attcam" value={ref.cameraRef} onChange={(e) => setRef({ ...ref, cameraRef: e.target.value })}
              placeholder="CAM-01 · Main gate" />
          </Field>
          <Field label="Recorded at" htmlFor="attwhen">
            <Input id="attwhen" type="datetime-local" value={ref.recordedAt}
              onChange={(e) => setRef({ ...ref, recordedAt: e.target.value })} />
          </Field>
          <Field label="Link (optional)" htmlFor="attloc" hint="Where an export is held">
            <Input id="attloc" value={ref.location} onChange={(e) => setRef({ ...ref, location: e.target.value })}
              placeholder="https://…" />
          </Field>
          <Field label="Note" htmlFor="attnote">
            <Input id="attnote" value={ref.note} onChange={(e) => setRef({ ...ref, note: e.target.value })}
              placeholder="e.g. held on the Hosur DVR, 30-day retention" />
          </Field>
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setShowRef(false)}>Cancel</Button>
            <Button className="px-2.5 py-1 text-xs" onClick={addReference}>Add reference</Button>
          </div>
        </div>
      )}

      {!value.length ? (
        <p className="rounded-xl bg-ink-50 px-3 py-2.5 text-xs text-ink-500">
          Nothing attached.
          {cfg.allowsReference && ` Clips over ${formatSize(MAX_UPLOAD_BYTES)} cannot be uploaded — record a reference so the footage can still be found.`}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {value.map((a) => {
            // Through safeHref, not raw. An attachment's url is stored text,
            // and a reference link is typed in by hand — so both are somewhere
            // a colleague could put javascript: and wait for the next person to
            // click it. safeHref returns '' for anything that is not http(s),
            // and the branch below already renders unlinked text when there is
            // no href, so a rejected URL degrades to a plain label.
            const href = safeHref(a.mode === 'reference' ? referenceHref(a) : a.url)
            const Icon = a.mode === 'reference' ? Video : Paperclip
            return (
              <li key={a.id} className="flex items-center gap-2 rounded-xl bg-ink-50 px-3 py-2 text-sm">
                <Icon size={14} className="shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 truncate">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="text-ink-800 hover:underline">
                      {a.mode === 'reference' ? describeReference(a) : a.name}
                    </a>
                  ) : (
                    <span className="text-ink-800">
                      {a.mode === 'reference' ? describeReference(a) : a.name}
                    </span>
                  )}
                  {a.mode === 'file' && a.size > 0 && (
                    <span className="ml-2 text-xs text-ink-400">{formatSize(a.size)}</span>
                  )}
                  {a.mode === 'reference' && a.note && (
                    <span className="ml-2 text-xs text-ink-400">{a.note}</span>
                  )}
                </span>
                {!disabled && (
                  <button type="button" onClick={() => remove(a.id)} className="shrink-0 text-ink-400 hover:text-red-600">
                    <X size={14} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
