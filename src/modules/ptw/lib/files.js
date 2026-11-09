// ─────────────────────────────────────────────────────────────────────────────
// File → base64 data URL helper for inline document storage in Firestore.
// Each file lives in its own doc under permits/{id}/documents, so the limit is
// the per-document 1 MB Firestore cap — we keep a safe margin at ~750 KB.
// ─────────────────────────────────────────────────────────────────────────────

// Permit attachments go to cloud storage; the old ~750KB ceiling was the
// Firestore document limit and now only governs the inline fallback
// (MAX_INLINE_BYTES in shared/storage).
export { MAX_UPLOAD_BYTES as MAX_FILE_BYTES } from '../../../../stack/lib/uploadLimits.js'
import { MAX_UPLOAD_BYTES as MAX_FILE_BYTES } from '../../../../stack/lib/uploadLimits.js'

const ACCEPTED = ['application/pdf', 'image/'] // pdf + any image/*

export function isAcceptedType(type = '') {
  return ACCEPTED.some((t) => type.startsWith(t))
}

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Read a File into { name, type, dataUrl, size }. Rejects oversize files and
 * unsupported types so callers can surface a clear toast.
 */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected'))
    if (!isAcceptedType(file.type)) return reject(new Error('Only PDF or image files are allowed'))
    if (file.size > MAX_FILE_BYTES) {
      return reject(new Error(`File is too large (${formatBytes(file.size)}). Max ${formatBytes(MAX_FILE_BYTES)}.`))
    }
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result, size: file.size })
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}
