// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import BrandMark from './BrandMark'
import { WE_EHS_MARK } from './OrgMark'

describe('BrandMark', () => {
  it('centres the Cult Fit SMS mark inside a Liquid Glass disc', () => {
    const { container } = render(<BrandMark alt="Cult Fit SMS" />)
    const disc = container.firstChild
    expect(disc.className).toMatch(/glass-mark/)
    expect(disc.className).toMatch(/place-items-center/)
    const img = container.querySelector('img')
    expect(img.getAttribute('src')).toBe(WE_EHS_MARK)
    expect(img.className).toMatch(/object-cover/)
    expect(img.className).toMatch(/object-center/)
    expect(img.className).toMatch(/inset-0/)
  })

  it('hides the image from assistive tech when alt is empty', () => {
    const { container } = render(<BrandMark alt="" />)
    expect(container.querySelector('img').getAttribute('aria-hidden')).toBe('true')
  })

  it('uses a compact disc on phones and full size from sm up', () => {
    const { container } = render(<BrandMark alt="Cult Fit SMS" />)
    expect(container.firstChild.className).toMatch(/h-12/)
    expect(container.firstChild.className).toMatch(/sm:h-16/)
  })
})
