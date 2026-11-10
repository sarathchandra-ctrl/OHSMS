// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import FieldNav from './FieldNav'

afterEach(cleanup)

function renderAt(path, props) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FieldNav {...props} />
    </MemoryRouter>
  )
}

describe('FieldNav', () => {
  it('offers Home and the five field destinations as links', () => {
    renderAt('/equipment/defects')
    const bar = screen.getByRole('navigation', { name: 'Field' })
    expect(bar).toBeTruthy()
    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Home',
      'QR Scan',
      'Tasks',
      'Report',
      'Defects',
      'Alerts',
    ])
    expect(links[0].getAttribute('href')).toBe('/field')
    expect(screen.getByRole('link', { name: 'QR Scan' }).getAttribute('href')).toBe('/field/scan')
    expect(screen.getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/field/tasks')
    expect(screen.getByRole('link', { name: 'Report' }).getAttribute('href')).toBe('/incidents/new')
    expect(screen.getByRole('link', { name: 'Defects' }).getAttribute('href')).toBe(
      '/equipment/defects'
    )
    expect(screen.getByRole('link', { name: 'Alerts' }).getAttribute('href')).toBe('/field/alerts')
  })

  it('marks Home current on the phone grid, including the portal route sign-in opens', () => {
    renderAt('/portal')
    const home = screen.getByRole('link', { name: 'Home' })
    expect(home.getAttribute('aria-current')).toBe('page')
    expect(home.className).toContain('text-brand-700')
    expect(home.className).toContain('min-h-14')
    expect(home.tabIndex).toBe(0)
    expect(screen.getByRole('link', { name: 'Report' }).getAttribute('aria-current')).toBeNull()

    cleanup()
    renderAt('/field')
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
  })

  it('leaves Home idle on a job and highlights that job instead', () => {
    renderAt('/field/tasks')
    const home = screen.getByRole('link', { name: 'Home' })
    expect(home.getAttribute('aria-current')).toBeNull()
    expect(home.className).toContain('text-ink-500')
    expect(screen.getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page')
  })

  it('follows the shell home when the chrome passes one', () => {
    renderAt('/portal', { homePath: '/portal' })
    const home = screen.getByRole('link', { name: 'Home' })
    expect(home.getAttribute('href')).toBe('/portal')
    expect(home.getAttribute('aria-current')).toBe('page')

    cleanup()
    renderAt('/field/scan', { homePath: '/portal' })
    const away = screen.getByRole('link', { name: 'Home' })
    expect(away.getAttribute('href')).toBe('/portal')
    expect(away.getAttribute('aria-current')).toBeNull()
  })
})
