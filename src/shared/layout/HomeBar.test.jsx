// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HomeBar from './HomeBar'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ org: null }),
}))

afterEach(cleanup)

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HomeBar />
    </MemoryRouter>
  )
}

describe('HomeBar', () => {
  it('hides on the portal home — offering Home there is noise', () => {
    renderAt('/portal')
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull()
  })

  it('names the portal page the person is on', () => {
    renderAt('/portal/training')
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(trail).toBeTruthy()
    expect(screen.getByRole('link', { name: /home/i }).getAttribute('href')).toBe('/portal')
    expect(screen.getByText('My training')).toBeTruthy()
  })

  it('names a field page without repeating a scan token', () => {
    renderAt('/field/scan')
    expect(screen.getByText('QR Scan')).toBeTruthy()
    cleanup()
    renderAt('/field/asset/SECRETTOKEN')
    expect(screen.getByText('Equipment')).toBeTruthy()
    expect(screen.queryByText('SECRETTOKEN')).toBeNull()
  })

  it('links the module home when inside a module', () => {
    renderAt('/permits/approvals')
    expect(screen.getByRole('link', { name: 'Permit to Work' }).getAttribute('href')).toBe(
      '/permits'
    )
  })

  it('uses a real label for admin routes rather than the path segment', () => {
    renderAt('/audit-log')
    expect(screen.getByText('Audit log')).toBeTruthy()
  })
})
