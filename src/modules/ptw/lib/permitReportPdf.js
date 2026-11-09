import { createElement } from 'react'
import PermitPrintable from '../components/PermitPrintable'
import { derivePermitStatus } from './permitStatus'
import { captureReactPdf } from '../../../shared/print/mailedReport'

/**
 * PermitPrintable, as a stored PDF. Status is derived the way the detail
 * page derives it, so the watermark matches the print. '' when capture
 * cannot run.
 */
export function capturePermitReport(permit, documents = []) {
  if (!permit) return Promise.resolve('')
  const view = {
    ...permit,
    status: permit.status || derivePermitStatus(permit, Date.now()),
  }
  const ref = permit.permitNo || permit.docId || 'permit'
  return captureReactPdf(
    `Permit-to-Work-${ref}.pdf`,
    createElement(PermitPrintable, { permit: view, documents })
  )
}
