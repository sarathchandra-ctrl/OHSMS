import { describe, expect, it } from 'vitest'
import { pointerPath } from './pointerPath'

describe('pointerPath', () => {
  it('prefers the recorded path', () => {
    expect(pointerPath({ path: 'files/a/x.jpg', url: 'https://ehs.test/blob?op=get&path=files/b/y.jpg' })).toBe('files/a/x.jpg')
    expect(pointerPath('files/a/x.jpg')).toBe('files/a/x.jpg')
  })

  // Older records kept only this server's download link, which no longer works.
  it('reads the path back out of this server\'s download link', () => {
    expect(pointerPath({ url: 'https://ehs.test/blob?op=get&path=files%2Fa%2Fx.jpg&sig=old' })).toBe('files/a/x.jpg')
  })

  it('reads nothing from other links, upload links or non-app paths', () => {
    expect(pointerPath({ url: 'https://elsewhere.test/photo.jpg' })).toBeNull()
    expect(pointerPath({ url: 'https://ehs.test/blob?op=put&path=files/a/x.jpg' })).toBeNull()
    expect(pointerPath({ url: 'https://ehs.test/blob?op=get&path=../etc/passwd' })).toBeNull()
    expect(pointerPath({ url: 'data:image/png;base64,AAAA' })).toBeNull()
    expect(pointerPath(null)).toBeNull()
  })
})
