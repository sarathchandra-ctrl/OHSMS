import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadAuditEvidence } from './attachments'
import { putFile, MAX_UPLOAD_BYTES, MAX_INLINE_BYTES } from '../../../shared/storage'

vi.mock('../../../shared/storage', () => ({
  putFile: vi.fn(),
  MAX_UPLOAD_BYTES: 2 * 1024 * 1024,
  MAX_INLINE_BYTES: 700 * 1024,
  formatSize: () => '2.0 MB',
  tooLargeForInline: () => 'File storage is unavailable',
}))

beforeEach(() => vi.clearAllMocks())

describe('audit evidence attachments', () => {
  it('keeps a 2 MB attachment in storage and returns its URL and path', async () => {
    const file = { name: 'evidence.pdf', size: MAX_UPLOAD_BYTES }
    const pointer = {
      url: 'https://ehs.example.com/blob?sig=example',
      path: 'files/audit-evidence/a.pdf',
    }
    vi.mocked(putFile).mockResolvedValue(pointer)
    expect(await uploadAuditEvidence(file)).toEqual(pointer)
    expect(putFile).toHaveBeenCalledWith('audit-evidence', file, file.name, {
      collection: 'auditFindings',
    })
  })

  it('refuses an oversized file before uploading it', async () => {
    await expect(uploadAuditEvidence({ size: MAX_UPLOAD_BYTES + 1 })).rejects.toThrow('2.0 MB')
    expect(putFile).not.toHaveBeenCalled()
  })

  it('does not silently embed large evidence when storage is unavailable', async () => {
    vi.mocked(putFile).mockResolvedValue(null)
    await expect(
      uploadAuditEvidence({ name: 'evidence.pdf', size: MAX_INLINE_BYTES + 1 })
    ).rejects.toThrow('File storage is unavailable')
  })
})
