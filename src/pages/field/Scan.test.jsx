// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  open: vi.fn(),
}))

vi.mock('../../shared/mobile/webScan', async () => {
  const actual = await vi.importActual('../../shared/mobile/webScan')
  return { ...actual, openScanner: (...args) => h.open(...args) }
})

const { default: Scan } = await import('./Scan')

function renderScan() {
  return render(
    <MemoryRouter>
      <Scan />
    </MemoryRouter>
  )
}

beforeEach(() => {
  cleanup()
  h.open.mockReset()
  delete window.BarcodeDetector
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  // jsdom has no camera. The page treats that as "cannot scan" and never
  // opens the preview, which is a different test than the one below.
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  })
})

afterEach(() => {
  cleanup()
  delete window.BarcodeDetector
})

describe('Scan preview', () => {
  it('puts the html5-qrcode box on screen before the scanner starts', async () => {
    h.open.mockImplementation(({ elementId, video }) => {
      h.readerHidden = document.getElementById(elementId).classList.contains('hidden')
      h.videoHidden = video.classList.contains('hidden')
      return new Promise(() => {})
    })
    renderScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    await waitFor(() => expect(h.open).toHaveBeenCalled())
    // `hidden` is display:none. html5-qrcode reads clientWidth while the box
    // is still hidden and stamps the video at 0px, which is the blank phone.
    expect(h.readerHidden).toBe(false)
    expect(h.videoHidden).toBe(true)
    expect(document.querySelector('[data-scan-frame]')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/Starting the camera/)
  })

  it('shows the video element, inline and muted, where BarcodeDetector exists', async () => {
    window.BarcodeDetector = class {}
    h.open.mockImplementation(({ video }) => {
      h.videoHidden = video.classList.contains('hidden')
      h.playsInline = video.getAttribute('playsinline')
      h.muted = video.muted
      return new Promise(() => {})
    })
    renderScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    await waitFor(() => expect(h.open).toHaveBeenCalled())
    expect(h.videoHidden).toBe(false)
    expect(h.playsInline).toBe('true')
    expect(h.muted).toBe(true)
    expect(document.querySelector('[data-scan-frame]')).toBeTruthy()
  })

  it('names a denied camera, a missing camera, and an insecure page', async () => {
    h.open.mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    renderScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission was denied/)

    cleanup()
    h.open.mockRejectedValue(new DOMException('no', 'NotFoundError'))
    renderScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/No camera was found/)

    cleanup()
    h.open.mockClear()
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    renderScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    expect(screen.getByRole('alert').textContent).toMatch(/https/)
    expect(h.open).not.toHaveBeenCalled()
  })

  it('stops a camera that resolves after the page has gone', async () => {
    const stop = vi.fn()
    let release
    h.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(stop)
        })
    )
    const { unmount } = renderScan()
    fireEvent.click(screen.getByRole('button', { name: /Start camera/ }))
    await waitFor(() => expect(h.open).toHaveBeenCalled())
    unmount()
    release()
    await waitFor(() => expect(stop).toHaveBeenCalled())
  })

  it('leaves an unrecognised code on the page and keeps the paste field', () => {
    renderScan()
    fireEvent.change(screen.getByLabelText(/paste the code/i), {
      target: { value: 'https://evil.test/login' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open code' }))
    expect(screen.getByRole('alert').textContent).toMatch(/not a Cult Fit SMS label/)
  })
})
