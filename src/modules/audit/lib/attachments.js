import {
  putFile,
  MAX_UPLOAD_BYTES,
  MAX_INLINE_BYTES,
  formatSize,
  tooLargeForInline,
} from '../../../shared/storage'

// Keep the legacy URL fields readable while new audit evidence goes to R2.
// Its path is retained beside the URL so the stored object can be identified.
export async function uploadAuditEvidence(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large. Max ${formatSize(MAX_UPLOAD_BYTES)}.`)
  }
  const stored = await putFile('audit-evidence', file, file.name, { collection: 'auditFindings' })
  if (stored) return stored
  if (file.size > MAX_INLINE_BYTES) throw new Error(tooLargeForInline(file.name))
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('That file could not be read. Try attaching it again.'))
    reader.readAsDataURL(file)
  })
  return { url, path: '' }
}
