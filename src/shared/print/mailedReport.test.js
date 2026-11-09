import { describe, it, expect } from 'vitest'
import { MAILED_REPORT_KIND, captureReactPdf, mailedReportPath } from './mailedReport'

describe('mailedReportPath', () => {
  const ok = 'orgs/orgA/mailed-reports/ab12cd34-report.pdf'

  it('uses the kind the functions and storage.rules exclude from client read', () => {
    expect(MAILED_REPORT_KIND).toBe('mailed-reports')
  })

  it('accepts only this org mailed-reports object', () => {
    expect(mailedReportPath(ok)).toBe(ok)
    expect(mailedReportPath('orgs/orgB/mailed-reports/ab-secret.pdf')).toBe('')
    expect(mailedReportPath('orgs/orgA/permit-documents/ab-method.pdf')).toBe('')
    expect(mailedReportPath('orgs/orgA/medical-records/ab-letter.pdf')).toBe('')
    expect(mailedReportPath('orgs/orgA/mailed-reports/../orgB/secret.pdf')).toBe('')
    expect(mailedReportPath('orgs/orgA/mailed-reports/nested/x.pdf')).toBe('')
    expect(mailedReportPath('https://storage.example/orgs/orgA/mailed-reports/a.pdf')).toBe(
      ''
    )
  })

  it('does not capture when there is no document to render into', async () => {
    expect(await captureReactPdf('report.pdf', { type: 'div' })).toBe('')
  })
})
