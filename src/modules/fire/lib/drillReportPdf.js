import { createElement } from 'react'
import MockDrillReport from '../components/MockDrillReport'
import { captureReactPdf } from '../../../shared/print/mailedReport'

/** MockDrillReport, as a stored PDF. '' when capture cannot run. */
export function captureDrillReport(record) {
  if (!record) return Promise.resolve('')
  const ref = record.docId || 'drill'
  return captureReactPdf(
    `Mock-Drill-Report-${ref}.pdf`,
    createElement(MockDrillReport, { record })
  )
}
