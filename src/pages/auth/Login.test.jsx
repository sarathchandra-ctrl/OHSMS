// @vitest-environment jsdom
//
// A dedicated build for a company on its own OIDC or SAML must not show the
// WEEHS password form. It did: the fields were rendered, required, and then
// thrown away on submit while the browser was sent to the IdP — a screen that
// collected a password nobody here checks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const login = vi.fn()

vi.mock('../../shared/auth/AuthContext', () => ({
  useAuth: () => ({
    login,
    loginWithSso: vi.fn(),
    completeMfa: vi.fn(),
    pendingMfa: null,
    clearPendingMfa: vi.fn(),
    isAuthed: false,
    profile: null,
    isPlatformAdmin: false,
    platformAdminReady: true,
  }),
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
vi.mock('./StoreBadges', () => ({ default: () => null }))

const { default: Login } = await import('./Login')

beforeEach(() => {
  vi.clearAllMocks()
  login.mockResolvedValue({ status: 'redirecting' })
})
afterEach(() => vi.unstubAllEnvs())

describe.each(['saml', 'oidc'])('own-stack build on company %s', (method) => {
  beforeEach(() => {
    vi.stubEnv('VITE_DATA_DRIVER', 'postgres')
    vi.stubEnv('VITE_AUTH_METHOD', method)
  })

  it('asks for no password and offers no WEEHS registration', () => {
    render(<Login />)
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.queryByText('Register')).toBeNull()
    expect(screen.queryByText('Join an existing one')).toBeNull()
  })

  it('hands off to the company IdP with nothing typed', () => {
    render(<Login />)
    fireEvent.click(screen.getByRole('button', { name: /continue with company sign-in/i }))
    expect(login).toHaveBeenCalledWith({ email: '', password: '' })
  })
})

describe('a dedicated environment before its handoff', () => {
  it('says it is not set up instead of asking for a password', () => {
    vi.stubEnv('VITE_DATA_DRIVER', 'postgres')
    vi.stubEnv('VITE_AUTH_METHOD', 'none')
    render(<Login />)
    expect(screen.getByText(/waiting for your organization/i)).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
  })
})

describe('builds that do sign in with a password here', () => {

  it('keeps it on an own-stack build that uses Supabase Auth', () => {
    vi.stubEnv('VITE_DATA_DRIVER', 'postgres')
    vi.stubEnv('VITE_AUTH_METHOD', 'supabase')
    render(<Login />)
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /company sign-in/i })).toBeNull()
  })
})
