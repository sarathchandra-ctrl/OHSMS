// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'

const state = vi.hoisted(() => ({
  orgCallback: null,
  entitlementCallback: null,
  stopOrg: vi.fn(),
  stopEntitlement: vi.fn(),
  profile: { role: 'member', status: 'approved' },
}))

vi.mock('../crypto', () => ({ clearKeyring: vi.fn() }))
vi.mock('../org/sharedSubscription', () => ({ clearSharedSubscriptions: vi.fn() }))
vi.mock('./sessionConstants', () => ({ startSession: vi.fn(), endSession: vi.fn() }))
vi.mock('./ownStackSession', () => ({
  sessionUid: () => 'member-test',
  currentAccessToken: () => 'session-test',
  clearAccessToken: vi.fn(),
  setAccessToken: vi.fn(),
  ownStackGateway: () => 'https://ehs.example.com',
  SESSION_ENDED_EVENT: 'ohsms:session-ended',
}))
vi.mock('../org/orgData', () => ({
  getUserProfile: async () => state.profile,
  subscribeOrg: (cb) => {
    state.orgCallback = cb
    return state.stopOrg
  },
}))
vi.mock('../modules/entitlements', () => ({
  normalizeEntitlement: () => ({ incidents: true }),
  isModuleEnabled: (map, key) => map[key] !== false,
  subscribeEntitlement: (cb) => {
    state.entitlementCallback = cb
    return state.stopEntitlement
  },
}))

function Workspace() {
  const auth = useAuth()
  return (
    <div>
      <p>{auth.modulesReady ? 'Modules ready' : 'Loading modules'}</p>
      <p>{auth.orgName || 'No organization'}</p>
      <p>{auth.moduleEnabled('incidents') ? 'Incidents enabled' : 'Incidents disabled'}</p>
    </div>
  )
}

afterEach(() => {
  cleanup()
  state.orgCallback = null
  state.entitlementCallback = null
  state.profile = { role: 'member', status: 'approved' }
  vi.clearAllMocks()
})

describe('workspace loading after sign-in', () => {
  it('finishes loading when module settings arrive and keeps organization details live', async () => {
    const view = render(
      <AuthProvider>
        <Workspace />
      </AuthProvider>
    )
    await waitFor(() => expect(state.entitlementCallback).toBeTypeOf('function'))
    expect(state.orgCallback).toBeTypeOf('function')
    expect(screen.getByText('Loading modules')).toBeTruthy()
    act(() => {
      state.orgCallback({ name: 'Example Organization' })
      state.entitlementCallback({ incidents: false })
    })
    expect(screen.getByText('Modules ready')).toBeTruthy()
    expect(screen.getByText('Example Organization')).toBeTruthy()
    expect(screen.getByText('Incidents disabled')).toBeTruthy()
    act(() => state.entitlementCallback({ incidents: true }))
    expect(screen.getByText('Incidents enabled')).toBeTruthy()
    view.unmount()
    expect(state.stopOrg).toHaveBeenCalledOnce()
    expect(state.stopEntitlement).toHaveBeenCalledOnce()
  })

  it('does not subscribe to restricted settings for a pending member', async () => {
    state.profile = { role: 'member', status: 'pending' }
    render(
      <AuthProvider>
        <Workspace />
      </AuthProvider>
    )
    await waitFor(() => expect(screen.getByText('Modules ready')).toBeTruthy())
    expect(state.orgCallback).toBeNull()
    expect(state.entitlementCallback).toBeNull()
  })
})
