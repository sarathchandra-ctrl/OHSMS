import { describe, it, expect } from 'vitest'
import { checkFileBytes } from './sniffType'

// ─────────────────────────────────────────────────────────────────────────────
// The server allow-lists the DECLARED content type, and the client supplies
// it. So the rule answers "may an object be served as this type" and nothing
// answered "are these bytes that type" — an .exe named report.pdf satisfied
// every check the system had (audit finding M-6, A.8.7).
// ─────────────────────────────────────────────────────────────────────────────

const bytes = (...b) => Uint8Array.from(b)
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const ZIP = [0x50, 0x4b, 0x03, 0x04]
const EXE = [0x4d, 0x5a, 0x90, 0x00]
const ELF = [0x7f, 0x45, 0x4c, 0x46]

describe('an executable is refused whatever it is called', () => {
  it('refuses a Windows executable declared as a PDF', () => {
    const v = checkFileBytes(bytes(...EXE), 'application/pdf')
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/Windows executable/)
  })

  it('refuses ELF and Mach-O even when declared as an image', () => {
    expect(checkFileBytes(bytes(...ELF), 'image/png').ok).toBe(false)
    expect(checkFileBytes(bytes(0xfe, 0xed, 0xfa, 0xce), 'image/jpeg').ok).toBe(false)
  })

  // The forbidden check runs before the declared type is even consulted, so
  // there is no type a caller can claim that lets one through.
  it('refuses an executable declared as octet-stream, which is otherwise open', () => {
    expect(checkFileBytes(bytes(...EXE), 'application/octet-stream').ok).toBe(false)
  })
})

describe('the bytes must not contradict the declared type', () => {
  it('accepts files that are what they say', () => {
    expect(checkFileBytes(bytes(...PDF), 'application/pdf').ok).toBe(true)
    expect(checkFileBytes(bytes(...PNG), 'image/png').ok).toBe(true)
    expect(checkFileBytes(bytes(...JPEG), 'image/jpeg').ok).toBe(true)
    expect(checkFileBytes(bytes(...JPEG), 'image/jpg').ok).toBe(true)
  })

  it('refuses a PNG declared as a PDF, and says which is which', () => {
    const v = checkFileBytes(bytes(...PNG), 'application/pdf')
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/declared as application\/pdf/)
    expect(v.reason).toMatch(/image\/png/)
  })

  it('accepts any zip container for an Office type, since all of them are zips', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    expect(checkFileBytes(bytes(...ZIP), docx).ok).toBe(true)
    expect(checkFileBytes(bytes(...ZIP), 'application/vnd.ms-excel').ok).toBe(true)
    // The pre-2007 formats are OLE compound files, not zips, and are equally valid.
    expect(checkFileBytes(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 'application/msword').ok).toBe(true)
  })

  it('reads the formats whose marker is not at the start', () => {
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)
    expect(checkFileBytes(webp, 'image/webp').ok).toBe(true)
    expect(checkFileBytes(webp, 'application/pdf').ok).toBe(false)
  })
})

describe('what it deliberately lets through', () => {
  // An allow-list of SIGNATURES, not of files. The declared type is already
  // constrained by the server's allow-list; refusing every unfamiliar first byte would
  // reject legitimate documents for being unusual.
  it('passes a format it does not recognise', () => {
    expect(checkFileBytes(bytes(0x01, 0x02, 0x03, 0x04), 'application/pdf').ok).toBe(true)
  })

  // Sealed uploads are AES-GCM ciphertext declared as octet-stream. They match
  // no signature by design, and this must never refuse them — it runs before
  // sealing precisely so it sees plaintext, but the sealed re-upload path and
  // any octet-stream download must stay open.
  it('passes ciphertext declared as octet-stream', () => {
    expect(checkFileBytes(bytes(0x9a, 0x4f, 0x21, 0xd3, 0x00, 0xff), 'application/octet-stream').ok).toBe(true)
  })

  it('passes an empty read rather than guessing', () => {
    expect(checkFileBytes(bytes(), 'application/pdf').ok).toBe(true)
    expect(checkFileBytes(null, 'application/pdf').ok).toBe(true)
  })

  it('accepts CSV, which has no signature, but not binary claiming to be CSV', () => {
    const csv = bytes(0x6e, 0x61, 0x6d, 0x65, 0x2c, 0x69, 0x64) // "name,id"
    expect(checkFileBytes(csv, 'text/csv').ok).toBe(true)
    // A NUL byte is the reliable tell; a CSV never contains one.
    expect(checkFileBytes(bytes(0x6e, 0x00, 0x6d), 'text/csv').ok).toBe(false)
  })
})

describe('the honest limit of this control', () => {
  // Stated as a test so nobody mistakes the check for malware detection. A
  // genuine PDF carrying a malicious payload passes, and SECURITY.md S-25 says
  // so rather than letting the existence of a check imply more than it does.
  it('passes a real PDF regardless of what is inside it', () => {
    const nasty = bytes(...PDF, 0x2f, 0x4a, 0x53) // %PDF-1.7 then "/JS"
    expect(checkFileBytes(nasty, 'application/pdf').ok).toBe(true)
  })
})
