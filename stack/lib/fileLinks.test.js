import { describe, expect, it } from 'vitest'
import { refreshFileLinks } from './fileLinks.js'

const sign = (path) => `https://ehs.test/blob?op=get&path=${encodeURIComponent(path)}&exp=9&sig=new`

describe('refreshFileLinks', () => {
  it('re-signs this server\'s download links anywhere in a record, whatever host they were saved under', () => {
    const out = refreshFileLinks(
      {
        photo: { url: 'http://127.0.0.1:5173/blob?op=get&path=files%2Fa%2Fx.jpg&sig=old', path: 'files/a/x.jpg' },
        list: ['https://old-host.test/blob?op=get&path=files/b/y.pdf&exp=1&sig=s'],
        n: 3,
      },
      sign
    )
    expect(out.photo.url).toBe(sign('files/a/x.jpg'))
    expect(out.photo.path).toBe('files/a/x.jpg')
    expect(out.list[0]).toBe(sign('files/b/y.pdf'))
    expect(out.n).toBe(3)
  })

  it('leaves other links alone, and never signs a path outside files/', () => {
    const data = {
      a: 'https://elsewhere.test/photo.jpg',
      b: 'https://ehs.test/blob?op=put&path=files/a/x.jpg&exp=1&sig=s',
      c: 'https://ehs.test/blob?op=get&path=secrets/x&sig=s',
      d: 'https://ehs.test/blob?op=get&path=files/../x&sig=s',
      e: 'note mentioning /blob? in text',
    }
    expect(refreshFileLinks(data, sign)).toEqual(data)
  })
})
