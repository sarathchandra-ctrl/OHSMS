import { describe, it, expect } from 'vitest'
import { MAILED_REPORT_KIND, captureReactPdf, mailedReportPath } from './mailedReport'

describe('mailedReportPath', () => {
  const ok = 'files/mailed-reports/ab12cd34-report.pdf'

  it('uses the kind the server excludes from client read', () => {
    expect(MAILED_REPORT_KIND).toBe('mailed-reports')
  })

  it('accepts only a mailed-reports object', () => {
    expect(mailedReportPath(ok)).toBe(ok)
    expect(mailedReportPath('orgs/orgB/mailed-reports/ab-secret.pdf')).toBe('') // the old per-tenant layout
    expect(mailedReportPath('files/permit-documents/ab-method.pdf')).toBe('')
    expect(mailedReportPath('files/medical-records/ab-letter.pdf')).toBe('')
    expect(mailedReportPath('files/mailed-reports/../other/secret.pdf')).toBe('')
    expect(mailedReportPath('files/mailed-reports/nested/x.pdf')).toBe('')
    expect(mailedReportPath('https://storage.example/files/mailed-reports/a.pdf')).toBe(
      ''
    )
  })

  it('does not capture when there is no document to render into', async () => {
    expect(await captureReactPdf('report.pdf', { type: 'div' })).toBe('')
  })
})
