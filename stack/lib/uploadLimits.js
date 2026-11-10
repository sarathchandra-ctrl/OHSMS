// A selected attachment may be at most 2 MiB. AES-GCM adds a 16-byte tag
// to sealed files; the IV and other encryption metadata live on the record.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
export const MAX_SEALED_UPLOAD_BYTES = MAX_UPLOAD_BYTES + 16

export const storedUploadLimit = (contentType = '') =>
  contentType.split(';')[0].trim().toLowerCase() === 'application/octet-stream'
    ? MAX_SEALED_UPLOAD_BYTES
    : MAX_UPLOAD_BYTES

// The content types a stored file may be served as. A file is served back
// with the type it was uploaded under, so this is what stops the file store
// becoming a host for HTML, SVG or script on the app's own origin — the
// download headers (DOWNLOAD_HEADERS, a sandboxing CSP) are the second line,
// not the only one. SVG is refused whatever it is called: it is a document
// that can run script. The office formats are spelled out; a wildcard over a
// vendor namespace would admit types nobody has read. Sealed files arrive as
// application/octet-stream. src/shared/storage/sniffType.js checks, in the
// browser, that the bytes match the declared type.
const ALLOWED_TYPES = [
  /^image\/(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/,
  /^video\/[-+.a-z0-9]+$/,
  /^audio\/[-+.a-z0-9]+$/,
  /^application\/pdf$/,
  /^text\/csv$/,
  /^application\/octet-stream$/,
  /^application\/msword$/,
  /^application\/vnd\.ms-(excel|powerpoint)$/,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/,
]

export function allowedUploadType(contentType = '') {
  const t = String(contentType).split(';')[0].trim().toLowerCase()
  return !t.includes('svg') && ALLOWED_TYPES.some((re) => re.test(t))
}
