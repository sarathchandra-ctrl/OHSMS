// A selected attachment may be at most 2 MiB. AES-GCM adds a 16-byte tag
// to sealed files; the IV and other encryption metadata live on the record.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
export const MAX_SEALED_UPLOAD_BYTES = MAX_UPLOAD_BYTES + 16

export const storedUploadLimit = (contentType = '') =>
  contentType.split(';')[0].trim().toLowerCase() === 'application/octet-stream'
    ? MAX_SEALED_UPLOAD_BYTES
    : MAX_UPLOAD_BYTES
