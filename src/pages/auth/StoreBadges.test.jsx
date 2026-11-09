// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StoreBadges from './StoreBadges'

const APPLE = 'https://apps.apple.com/app/weehs-ohsms/id0000000000'
const FLIGHT = 'https://testflight.apple.com/join/abc'

afterEach(cleanup)

describe('StoreBadges', () => {
  it('offers iPhone installation without an Android package or store listing', () => {
    render(<StoreBadges links={{ appStore: null }} />)
    expect(screen.queryByRole('link', { name: /APK|Google Play/i })).toBeNull()
    expect(screen.queryByText(/install unknown apps/i)).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Install on iPhone' })).toBeTruthy()
  })

  it('explains Home Screen install and closes the guide', () => {
    render(<StoreBadges links={{ appStore: null }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Install on iPhone' }))
    expect(screen.getByRole('dialog', { name: 'Install on iPhone' })).toBeTruthy()
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('links an App Store badge only to a valid listing', () => {
    render(<StoreBadges links={{ appStore: APPLE }} />)
    const apple = screen.getByRole('link', { name: /Download on the App Store/ })
    expect(apple.getAttribute('href')).toBe(APPLE)
    expect(apple.getAttribute('rel')).toBe('noopener noreferrer')
    cleanup()
    render(<StoreBadges links={{ appStore: 'https://evil.example/app' }} />)
    expect(screen.queryByRole('link', { name: /App Store/ })).toBeNull()
  })

  it('shows a TestFlight link only for the official host', () => {
    render(<StoreBadges links={{ appStore: null, testFlight: FLIGHT }} />)
    expect(screen.getByRole('link', { name: /Join the TestFlight/ }).getAttribute('href')).toBe(
      FLIGHT
    )
    cleanup()
    render(<StoreBadges links={{ testFlight: 'https://evil.example/join' }} />)
    expect(screen.queryByRole('link', { name: /TestFlight/ })).toBeNull()
  })

  it('does not fetch installation settings inside the native shell', () => {
    const load = vi.fn()
    const { container } = render(<StoreBadges native load={load} />)
    expect(container.firstChild).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('loads only public store settings, with no APK release request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const load = vi.fn(async () => ({ appStoreUrl: APPLE }))
    try {
      render(<StoreBadges load={load} />)
      expect((await screen.findByRole('link', { name: /App Store/ })).getAttribute('href')).toBe(
        APPLE
      )
      expect(load).toHaveBeenCalledOnce()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
