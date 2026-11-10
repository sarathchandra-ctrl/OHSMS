// The PDF a lifecycle mail attaches.
//
// Mock drills, meeting minutes, the initial incident report and permit-to-work
// are printed from React components (react-to-print / window.print). That
// dialog never yields bytes, and nothing used to store the result, so the
// mail functions drew a separate Helvetica document. Recipients were opening
// one layout in the app and another from the mailbox.
//
// The save that sends the mail renders the same component, turns that DOM
// into a PDF, and uploads it here before the Firestore write. The function
// downloads that object. It does not redraw the report.
//
// The file is not sealed. Sealing it would hand the function ciphertext, and
// the mailer skips sealed bytes rather than attach an envelope. The plaintext
// is the decrypted print — names, minutes, narrative — so the server issues
// no download link for this kind to any browser (stack/presign.mjs). A member can create the object; they
// already hold the text they just typed.
//
// `MAILED_REPORT_KIND` is duplicated in stack/lib/mailAttachments.js.
// The two packages cannot import each other. Both tests pin the same literal.
import { reportError } from '../monitoring'
import { putFile, removeFile } from '../storage'

export const MAILED_REPORT_KIND = 'mailed-reports'

const MAX_PAGES = 25

/** A path this app will treat as one of its own mailed-report objects. */
export function mailedReportPath(filePath) {
  if (typeof filePath !== 'string') return ''
  const path = filePath.trim()
  if (!path || path.length > 512) return ''
  if (path.includes('..') || path.includes('\\') || path.includes('\0') || path.includes('//')) {
    return ''
  }
  const prefix = `files/${MAILED_REPORT_KIND}/`
  if (!path.startsWith(prefix)) return ''
  const rest = path.slice(prefix.length)
  if (!rest || rest.includes('/')) return ''
  return path
}

/** Best-effort. An orphaned object is a cost; a failed delete must not block the record delete. */
export function discardMailedReport(filePath) {
  const path = mailedReportPath(filePath)
  if (path) removeFile(path)
}

async function canvasToPdfBlob(canvas, jsPDF) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const pageWidth = 210
  const pageHeight = 297
  const pxPerMm = canvas.width / pageWidth
  const pageSlicePx = Math.max(1, Math.floor(pageHeight * pxPerMm))
  const pageCanvas = document.createElement('canvas')
  const ctx = pageCanvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  pageCanvas.width = canvas.width
  let y = 0
  let page = 0
  // A client-writable record must not produce an unbounded upload. Twenty-five
  // A4 pages is past any of these four reports; the rest is dropped rather
  // than wedging the save.
  while (y < canvas.height && page < MAX_PAGES) {
    const slice = Math.min(pageSlicePx, canvas.height - y)
    pageCanvas.height = slice
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageCanvas.width, slice)
    ctx.drawImage(canvas, 0, y, canvas.width, slice, 0, 0, canvas.width, slice)
    const img = pageCanvas.toDataURL('image/jpeg', 0.85)
    if (page > 0) pdf.addPage()
    pdf.addImage(img, 'JPEG', 0, 0, pageWidth, slice / pxPerMm)
    y += slice
    page += 1
  }
  return pdf.output('blob')
}

/**
 * Render `node` off-screen and return a PDF blob of that DOM.
 * The node is the same component the print button mounts.
 */
export async function renderElementPdf(node) {
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const { toCanvas } = await import('html-to-image')
  const { jsPDF } = await import('jspdf')

  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  // Off-screen, not display:none. html-to-image measures the element; a
  // hidden node has no box and the capture comes back empty.
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:210mm;background:#ffffff;'
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    flushSync(() => {
      root.render(node)
    })
    if (document.fonts?.ready) await document.fonts.ready
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })
    const imgs = [...host.querySelectorAll('img')]
    await Promise.all(
      imgs.map((img) =>
        img.complete
          ? null
          : new Promise((resolve) => {
              img.onload = resolve
              img.onerror = resolve
            })
      )
    )
    const target = host.firstElementChild || host
    const canvas = await toCanvas(target, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      cacheBust: true,
    })
    if (!canvas?.width || !canvas?.height) return null
    return canvasToPdfBlob(canvas, jsPDF)
  } finally {
    root.unmount()
    host.remove()
  }
}

export async function uploadMailedReport(blob, fileName) {
  if (!blob || !blob.size) return ''
  const name = String(fileName || 'report')
    .toLowerCase()
    .endsWith('.pdf')
    ? fileName
    : `${fileName || 'report'}.pdf`
  const file = new File([blob], name, { type: 'application/pdf' })
  // No `collection`. sealFileBytes would encrypt the object, and the mail
  // function has no content key — it would skip the file as sealed.
  const up = await putFile(MAILED_REPORT_KIND, file, name)
  return up?.path || ''
}

/**
 * Render, upload, and return the storage path. '' when there is no document
 * (tests, a save that is not in a browser) or when capture fails. A failed
 * capture must not fail the save: the mail still goes, without the file.
 */
export async function captureReactPdf(fileName, node) {
  if (typeof document === 'undefined' || !node) return ''
  try {
    const blob = await renderElementPdf(node)
    return await uploadMailedReport(blob, fileName)
  } catch (err) {
    reportError(err, { source: 'print.captureReactPdf' })
    return ''
  }
}
