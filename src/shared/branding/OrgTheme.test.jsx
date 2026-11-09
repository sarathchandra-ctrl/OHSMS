// @vitest-environment jsdom
import { render, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useAuth = vi.hoisted(() => vi.fn())
const useFileUrl = vi.hoisted(() => vi.fn())
const updateOrgSettings = vi.hoisted(() => vi.fn())
const extractPaletteFromSrc = vi.hoisted(() => vi.fn())
const reportError = vi.hoisted(() => vi.fn())

vi.mock('../auth/AuthContext', () => ({ useAuth }))
vi.mock('../storage/useFileUrl', () => ({
  useFileUrl,
  inlineImageSrc: (url) => {
    const s = typeof url === 'string' ? url.trim() : ''
    return s.startsWith('data:image/') || s.startsWith('blob:') ? s : ''
  },
}))
vi.mock('../org/orgData', () => ({ updateOrgSettings }))
vi.mock('../monitoring', () => ({ reportError }))
vi.mock('./theme', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, extractPaletteFromSrc }
})

const { default: OrgTheme } = await import('./OrgTheme')
const { applyOrgTheme } = await import('./theme')

const THUMB = 'data:image/jpeg;base64,thumb'
const ORG = {
  logoPath: 'orgs/a/org-logo/x.png',
  logoUrl: THUMB,
  theme: { accent: '#6db3aa', canvas: '#f6e3bb', canvasSource: 'default' },
}

afterEach(() => {
  cleanup()
  applyOrgTheme(null)
})

beforeEach(() => {
  useAuth.mockReset()
  useFileUrl.mockReset()
  updateOrgSettings.mockReset()
  extractPaletteFromSrc.mockReset()
  reportError.mockReset()
  updateOrgSettings.mockResolvedValue(undefined)
  useFileUrl.mockReturnValue({ src: THUMB, loading: false })
})

describe('OrgTheme', () => {
  it('paints and persists colours sampled from the inline thumb when the stored theme is still the kit', async () => {
    useAuth.mockReturnValue({
      org: ORG,
      isAdmin: true,
      actor: { uid: 'u1', name: 'Ada' },
    })
    extractPaletteFromSrc.mockResolvedValue({ accent: '#c43d32', canvasWash: '#f8e4e2' })

    render(<OrgTheme />)

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--brand-400').toLowerCase()).toBe(
        '#c43d32'
      )
    })
    expect(extractPaletteFromSrc).toHaveBeenCalledWith(THUMB)
    expect(document.documentElement.style.getPropertyValue('--canvas').toLowerCase()).not.toBe(
      '#f6e3bb'
    )
    await waitFor(() => {
      expect(updateOrgSettings).toHaveBeenCalledTimes(1)
    })
    const patch = updateOrgSettings.mock.calls[0][0]
    expect(patch.theme.canvasSource).toBe('logo')
    expect(patch.theme.accent).toBe('#c43d32')
  })

  it('applies a stored logo theme without sampling or writing', async () => {
    useAuth.mockReturnValue({
      org: {
        ...ORG,
        theme: { accent: '#4a90d9', canvas: '#faf3ea', canvasSource: 'logo' },
      },
      isAdmin: true,
      actor: { uid: 'u1', name: 'Ada' },
    })

    render(<OrgTheme />)

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--brand-400').toLowerCase()).toBe(
        '#4a90d9'
      )
    })
    expect(document.documentElement.style.getPropertyValue('--canvas').toLowerCase()).toBe(
      '#faf3ea'
    )
    expect(extractPaletteFromSrc).not.toHaveBeenCalled()
    expect(updateOrgSettings).not.toHaveBeenCalled()
  })

  it('paints a sampled theme for a member without writing the org document', async () => {
    useAuth.mockReturnValue({
      org: ORG,
      isAdmin: false,
      actor: { uid: 'u2', name: 'Bea' },
    })
    extractPaletteFromSrc.mockResolvedValue({ accent: '#c43d32', canvasWash: '#f8e4e2' })

    render(<OrgTheme />)

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--brand-400').toLowerCase()).toBe(
        '#c43d32'
      )
    })
    expect(updateOrgSettings).not.toHaveBeenCalled()
  })

  it('samples the thumb when the hook has only a download URL', async () => {
    useFileUrl.mockReturnValue({
      src: 'https://firebasestorage.googleapis.com/o/logo.jpg?alt=media&token=t',
      loading: false,
    })
    useAuth.mockReturnValue({
      org: ORG,
      isAdmin: false,
      actor: { uid: 'u2', name: 'Bea' },
    })
    extractPaletteFromSrc.mockResolvedValue({ accent: '#4a90d9', canvasWash: '#e7f0fa' })

    render(<OrgTheme />)

    await waitFor(() => {
      expect(extractPaletteFromSrc).toHaveBeenCalledWith(THUMB)
    })
  })
})
