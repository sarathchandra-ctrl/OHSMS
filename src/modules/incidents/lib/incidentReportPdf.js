import { createElement } from 'react'
import IncidentReportDoc from '../components/IncidentReportDoc'
import { captureReactPdf } from '../../../shared/print/mailedReport'

/**
 * The initial incident report (`full` false), as a stored PDF.
 *
 * Clinical injury detail is omitted. This mail also goes to members, who
 * cannot open /injuries, and the on-screen initial report already says so
 * when `medicalAvailable` is false. Passing the saver's own injuries here
 * would put that detail in every recipient's inbox.
 */
export function captureIncidentReport(incident, { org, photos = [] } = {}) {
  if (!incident) return Promise.resolve('')
  const ref = incident.refNo || incident.docId || 'incident'
  return captureReactPdf(
    `Incident-Report-${ref}.pdf`,
    createElement(IncidentReportDoc, {
      incident,
      photos,
      org,
      full: false,
      injuries: [],
      medicalAvailable: false,
    })
  )
}
