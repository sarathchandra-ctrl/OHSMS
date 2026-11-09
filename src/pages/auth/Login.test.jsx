// @vitest-environment jsdom
//
// Email and password, checked by this installation's server. No company
// sign-in button, no registration, no setup link.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const login = vi.fn()

vi.mock('../../shared/auth/AuthContext', () => ({
  useAuth: () => ({ login, isAuthed: false, profile: null }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children }) => children,
  Navigate: () => null,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ state: null }),
}))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))
vi.mock('./AuthLayout', () => ({ default: ({ children, footer }) => [children, footer] }))
vi.mock('./LoginModules', () => ({ default: () => null }))

const { default: Login } = await import('./Login')
const toast = (await import('react-hot-toast')).default

beforeEach(() => {
  vi.clearAllMocks()
  login.mockResolvedValue({ status: 'signed-in' })
})

describe('sign-in', () => {
  it('asks for an email and a password, and offers nothing else', () => {
    render(<Login />)
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.queryByText(/company sign-in/i)).toBeNull()
    expect(screen.queryByText(/set up/i)).toBeNull()
    expect(screen.queryByText(/register/i)).toBeNull()
  })

  it('sends what was typed to the server', async () => {
    render(<Login />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@cult.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ email: 'ana@cult.test', password: 'secret-pass-1' })
    )
  })

  it("shows the server's refusal", async () => {
    login.mockRejectedValue(new Error('That email and password do not match.'))
    render(<Login />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@cult.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-pass-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That email and password do not match.')
    )
  })
})
