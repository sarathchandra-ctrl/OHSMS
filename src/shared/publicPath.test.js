import { describe, expect, it } from 'vitest'
import { publicPath } from './publicPath'

describe('publicPath', () => {
  it('keeps the root path for a normal deployment', () => {
    expect(publicPath('/brand/logo.svg')).toBe('/brand/logo.svg')
    expect(publicPath('brand/logo.svg')).toBe('/brand/logo.svg')
  })
})
