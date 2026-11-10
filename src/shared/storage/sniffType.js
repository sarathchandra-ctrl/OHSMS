// ─────────────────────────────────────────────────────────────────────────────
// What a file ACTUALLY is, from its first bytes — not from what the upload
// claims it is.
//
// ── The gap this closes (audit finding M-6, A.8.7) ──────────────────────────
//
// The server allow-lists content types (allowedUploadType in
// stack/lib/uploadLimits.js), and that allow-list is genuinely load-bearing:
// it is what stops an object being SERVED as text/html from the app's own
// origin, which would make the evidence store a phishing host. But it
// constrains the declared Content-Type, and that value is supplied by the
// client. A browser sets it from the file extension; anything
// that is not this app sets it to whatever it likes.
//
// So the rule answers "may an object be served as this type", and nothing
// answered "is this file what it says it is". Members upload documents into a
// shared store and colleagues download them, which makes the app a distribution
// path between employees — the thing A.8.7 is actually about. Nothing scanned
// any of it.
//
// ── Why this is a sniffer and not a virus scanner ───────────────────────────
//
// A real scanner needs infrastructure this project does not have (ClamAV on
// Cloud Run) or a third-party API — and sending occupational health records,
// GP letters and fit notes to a scanning vendor is a worse privacy outcome than
// not scanning, and would make that vendor a subprocessor of medical data.
// Worse, it cannot work at all where it matters most: files in the sealed
// collections are AES-GCM ciphertext at rest, so there is nothing for any
// scanner to read. See docs/SECURITY.md S-25.
//
// What is proportionate, needs no infrastructure, and is testable is this:
// refuse the upload when the bytes disagree with the declared type, and refuse
// executables outright. That closes the case where a file is not what the
// person downloading it will believe it is, which is the precondition for
// almost every way this becomes somebody's problem.
//
// It is NOT a claim that a conforming file is safe. A genuine PDF can carry a
// malicious payload and this will pass it. The control is honesty about type,
// not detection of malice, and SECURITY.md says so rather than letting the
// existence of a check imply more than it does.
// ─────────────────────────────────────────────────────────────────────────────

/** How many bytes we need to see. The longest signature below is 12. */
export const SNIFF_BYTES = 64

/**
 * Formats that are never acceptable, whatever they claim to be.
 *
 * Executables and installers, in the formats a browser or a colleague's machine
 * will actually run. An .exe renamed to .pdf is the whole vector: the allow-list
 * on the server sees `application/pdf`, the store keeps it, and the
 * download is an executable sitting in somebody's Downloads folder with a
 * document's name.
 */
const FORBIDDEN = [
  { name: 'Windows executable (PE)', bytes: [0x4d, 0x5a] },                       // MZ
  { name: 'Linux executable (ELF)', bytes: [0x7f, 0x45, 0x4c, 0x46] },            // .ELF
  { name: 'macOS executable (Mach-O)', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'macOS executable (Mach-O)', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'macOS executable (Mach-O)', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Java class file', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'Windows shortcut', bytes: [0x4c, 0x00, 0x00, 0x00] },                  // .lnk
]

/**
 * Signatures for the formats this app accepts, keyed to the MIME family they
 * must match.
 *
 * `offset` because a few formats do not start with their marker: RIFF/WEBP puts
 * it at 8, and MP4/HEIC put `ftyp` at 4.
 */
const SIGNATURES = [
  { family: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { family: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { family: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { family: 'image/bmp', bytes: [0x42, 0x4d] },
  { family: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { family: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { family: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { family: 'image/heic', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { family: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },                 // %PDF
  // The Office formats and every other zip container. A .docx, .xlsx and .pptx
  // are all zips, and so is an ODF file — this cannot tell them apart and does
  // not try. What it establishes is that the bytes ARE a zip container, which
  // is the claim the declared type makes.
  { family: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { family: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] },                             // empty archive
  { family: 'zip', bytes: [0x50, 0x4b, 0x07, 0x08] },                             // spanned
  { family: 'ole', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },     // legacy .doc/.xls/.ppt
  { family: 'video/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { family: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },                      // also .mka/.mkv
  { family: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },                            // ID3
  { family: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { family: 'audio/wav', bytes: [0x57, 0x41, 0x56, 0x45], offset: 8 },
]

/** Which signature families satisfy a declared MIME type. */
function acceptableFamilies(declared) {
  const t = String(declared || '').toLowerCase().split(';')[0].trim()
  if (t === 'image/jpg') return ['image/jpeg']
  if (t === 'image/heif') return ['image/heic']
  if (t.startsWith('image/')) return [t]
  if (t === 'application/pdf') return ['application/pdf']
  if (t === 'text/csv' || t.startsWith('text/')) return ['text']
  // Every modern Office format is a zip; the pre-2007 ones are OLE compound
  // files. Both are legitimate for the same declared type.
  if (t.startsWith('application/vnd.') || t === 'application/msword') return ['zip', 'ole']
  // Ciphertext, and the fallback for anything the app uploads as a download
  // rather than a document. Deliberately unconstrained: sealed bytes match no
  // signature at all, by design.
  if (t === 'application/octet-stream') return null
  if (t.startsWith('video/')) return ['video/mp4', 'video/webm']
  if (t.startsWith('audio/')) return ['audio/mpeg', 'audio/ogg', 'audio/wav', 'video/webm']
  return null
}

const startsWith = (head, bytes, offset = 0) =>
  bytes.every((b, i) => head[offset + i] === b)

/** Is this plausibly text? Used only to accept CSV, which has no signature. */
function looksTextual(head) {
  if (!head.length) return true
  for (const b of head) {
    // NUL is the reliable tell for binary; a CSV never contains one.
    if (b === 0x00) return false
  }
  return true
}

/**
 * Check the first bytes of a file against what it claims to be.
 *
 * @param head     the first SNIFF_BYTES bytes, as a Uint8Array or array
 * @param declared the content type the upload is claiming
 * @returns `{ ok, reason }` — `reason` is a sentence fit to show a person
 *
 * Unknown formats PASS. This is an allow-list of signatures, not of files: the
 * declared type is already constrained by the server's allow-list, and refusing anything
 * whose first bytes are unfamiliar would reject legitimate documents for being
 * unusual. Only two things fail — a known-executable header, and a declared
 * type that the bytes actively contradict.
 */
export function checkFileBytes(head, declared) {
  const bytes = head instanceof Uint8Array ? head : Uint8Array.from(head || [])
  if (!bytes.length) return { ok: true, reason: '' }

  for (const f of FORBIDDEN) {
    if (startsWith(bytes, f.bytes)) {
      return {
        ok: false,
        reason: `This file is a ${f.name}, which cannot be uploaded whatever it is named.`,
      }
    }
  }

  const families = acceptableFamilies(declared)
  if (!families) return { ok: true, reason: '' }

  if (families[0] === 'text') {
    return looksTextual(bytes)
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'This file was uploaded as text or CSV but contains binary data.' }
  }

  const matched = SIGNATURES.filter((s) => startsWith(bytes, s.bytes, s.offset || 0))
  // Nothing recognised at all: unusual, not wrong. See the note above.
  if (!matched.length) return { ok: true, reason: '' }
  if (matched.some((s) => families.includes(s.family))) return { ok: true, reason: '' }

  const actual = matched[0].family
  return {
    ok: false,
    reason: `This file is declared as ${declared || 'an unknown type'} but its contents are ${actual}. `
      + 'Re-save it in the format it claims to be, or upload it under its real name.',
  }
}

/**
 * Read the first bytes of a Blob. Separated so checkFileBytes stays pure.
 *
 * Two ways of reading, because `Blob.prototype.arrayBuffer` is not everywhere.
 * jsdom does not implement it at all — which is how the first version of this
 * check came to do nothing in the test environment: `headOf` threw, putFile's
 * catch swallowed it, and the upload degraded to the inline path carrying the
 * very bytes the check exists to refuse. A control that silently fails open is
 * worse than none, because the test suite goes green either way.
 *
 * So: arrayBuffer when it exists, FileReader when it does not, and a thrown
 * error rather than an empty read if neither works. An empty read passes
 * `checkFileBytes`, so returning one on failure would be the same silent
 * fail-open in a different place.
 */
export async function headOf(blob) {
  if (!blob?.slice) return new Uint8Array()
  const head = blob.slice(0, SNIFF_BYTES)

  if (typeof head.arrayBuffer === 'function') {
    return new Uint8Array(await head.arrayBuffer())
  }

  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result))
      reader.onerror = () => reject(reader.error || new Error('could not read the file'))
      reader.readAsArrayBuffer(head)
    })
  }

  throw new Error('cannot read file contents to verify its type')
}
