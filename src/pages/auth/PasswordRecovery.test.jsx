// @vitest-environment jsdom
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ForgotPassword from './ForgotPassword'
import ResetPassword from './ResetPassword'

const config = vi.hoisted(() => ({ reset: 'off' }))
vi.mock('../../shared/runtimeConfig', () => ({ runtimeEnv: () => config.reset }))
vi.mock('../../shared/auth/ownStackSession', () => ({
  ownStackGateway: () => 'https://ehs.example.com',
}))
vi.mock('react-router-dom', () => ({ Link: ({ children, to }) => <a href={to}>{children}</a> }))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }))
vi.mock('./AuthLayout', () => ({
  default: ({ title, subtitle, children, footer }) => (
    <main>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
      {footer}
    </main>
  ),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  config.reset = 'off'
  window.history.replaceState({}, '', '/')
})

describe('password recovery', () => {
  it('explains how to recover access when email is not enabled', () => {
    render(<ForgotPassword />)
    expect(screen.getByRole('status').textContent).toContain('Ask an administrator')
    expect(screen.queryByRole('button', { name: 'Email me a reset link' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe(
      '/login'
    )
  })

  it('requests an emailed link when the server advertises email reset', async () => {
    config.reset = 'on'
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: 'Check your email.' }),
    }))
    vi.stubGlobal('fetch', fetch)
    render(<ForgotPassword />)
    fireEvent.change(screen.getByLabelText('Work email'), {
      target: { value: 'user@example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Check your email.'))
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ email: 'user@example.test' })
    expect(fetch.mock.calls[0][0]).toBe('https://ehs.example.com/auth/forgot')
  })

  it('retains an emailed token in StrictMode and removes it from the address bar after rendering', async () => {
    const token = 'example-reset-token-for-testing-123456789'
    const state = { key: 'router-key', idx: 2 }
    window.history.replaceState(state, '', `/reset-password?source=email#token=${token}`)
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetch)
    render(
      <StrictMode>
        <ResetPassword />
      </StrictMode>
    )
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?source=email')
    expect(window.history.state).toEqual(state)
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-123' },
    })
    fireEvent.change(screen.getByLabelText('New password again'), {
      target: { value: 'new-password-123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Your password has been changed')
    )
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token, password: 'new-password-123' })
  })

  it('does not offer a password change without an emailed token', () => {
    render(<ResetPassword />)
    expect(screen.getByText('This link is not complete')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull()
  })
})
