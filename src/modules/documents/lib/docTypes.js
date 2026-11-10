/**
 * What a document IS, how it is reached, and where its bytes are stored.
 *
 * A record carrying a title, a version and a review date but no way to open the
 * thing it describes is an index of documents nobody can read — so the source
 * (an upload or a link) lives here, next to the type.
 *
 * WHERE a document is filed is not here: that is tree.js, which imports this
 * file for the storage path and nothing else. The dependency runs one way.
 */

// The four the library started with, then the engineering records a site
// accumulates and has to produce on demand — commissioning drawings, pressure
// tests, structural and electrical calculations. These are the ones that get
// asked for in an audit and found in somebody's email.
export const DOC_TYPES = [
  { value: 'Policy', label: 'Policy', tone: 'brand' },
  { value: 'SOP', label: 'SOP', tone: 'blue' },
  { value: 'SDS', label: 'SDS', tone: 'amber' },
  { value: 'Form', label: 'Form', tone: 'gray' },
  { value: 'GFC', label: 'GFC (Good For Construction)', tone: 'blue' },
  { value: 'HPT', label: 'HPT (Hydrostatic Pressure Test)', tone: 'violet' },
  { value: 'Structural Stability', label: 'Structural Stability', tone: 'green' },
  { value: 'Load Balancing', label: 'Load Balancing', tone: 'green' },
  { value: 'UPS & Power Backup Calculation', label: 'UPS & Power Backup Calculation', tone: 'violet' },
]

export const DOC_TYPE_BY_VALUE = Object.fromEntries(DOC_TYPES.map((t) => [t.value, t]))
export const docTypeTone = (v) => DOC_TYPE_BY_VALUE[v]?.tone || 'gray'
export const docTypeLabel = (v) => DOC_TYPE_BY_VALUE[v]?.label || v || '—'

// ── How the document is reached ──────────────────────────────────────────────

export const SOURCE_UPLOAD = 'upload'
export const SOURCE_LINK = 'link'

export const SOURCE_OPTIONS = [
  { value: SOURCE_UPLOAD, label: 'Upload a file' },
  { value: SOURCE_LINK, label: 'Link to it' },
]

/**
 * Only http(s). A document library is a place people click things, and a
 * javascript: or data: URL stored by one member and opened by another is
 * stored XSS with an audience — the same reason shared/safeUrl exists. Checked
 * on the way IN as well as on render, so a bad value never reaches the record.
 */
export function isSafeDocumentUrl(url) {
  const s = String(url || '').trim()
  if (!s) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Where a document can actually be opened, or '' when there is nothing yet. */
export function documentHref(doc) {
  if (doc?.source === SOURCE_LINK) return isSafeDocumentUrl(doc.linkUrl) ? String(doc.linkUrl).trim() : ''
  return doc?.file?.url || ''
}

export const hasDocument = (doc) => Boolean(documentHref(doc))

/** What to call the thing being opened, for a link's text and a title. */
export function documentLabel(doc) {
  if (doc?.source === SOURCE_LINK) {
    const href = documentHref(doc)
    if (!href) return ''
    try {
      return new URL(href).hostname.replace(/^www\./, '')
    } catch {
      return 'Link'
    }
  }
  return doc?.file?.name || ''
}

// ── Where the bytes go ───────────────────────────────────────────────────────

export const FOLDER_PREFIX = 'documents'

/**
 * The storage folder a file is uploaded into — one per REGION, plus one for org
 * level. NOT one per folder in the tree.
 *
 * The bucket layout deliberately does not mirror the tree. storagePath()
 * sanitises every path segment (a slash becomes an underscore) into
 * files/{kind}/{fileName}, so a nested path would be silently flattened — and encoding a whole
 * region/entity/site/bucket chain into the single `kind` segment would produce a
 * key that changes the moment anybody renames a site. The tree lives in
 * Firestore, where it can be reorganised freely; the bytes stay where they were
 * put, and the document record is what connects the two.
 *
 * The region is sanitised HERE, by the same rule storagePath() applies, so the
 * folder recorded on the document is byte-identical to the path the file went
 * to. A region name that survives none of it — nothing in A-Za-z0-9 at all —
 * would make storagePath throw, so those share one region folder rather than
 * failing the upload outright.
 *
 * @param region the region name, or null/'' for org level and unfiled
 */
export function storageKindFor(region) {
  const name = String(region ?? '').trim()
  if (!name) return `${FOLDER_PREFIX}-org`
  const slug = name.replace(/[^A-Za-z0-9_-]/g, '_')
  return /[A-Za-z0-9]/.test(slug) ? `${FOLDER_PREFIX}-region-${slug}` : `${FOLDER_PREFIX}-region`
}
