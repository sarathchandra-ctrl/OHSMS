import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { clearKeyring } from '../crypto'
import { clearSharedSubscriptions } from '../org/sharedSubscription'
import { startSession, endSession } from './sessionConstants'
import {
  normalizeEntitlement,
  subscribeEntitlement,
  isModuleEnabled,
} from '../modules/entitlements'
import { getUserProfile, subscribeOrg } from '../org/orgData'
import { personalModuleMap } from './access'
import {
  clearAccessToken,
  currentAccessToken,
  ownStackGateway,
  sessionUid,
  setAccessToken,
} from './ownStackSession'

const AuthContext = createContext(null)

// One organization per installation. People sign in with an email and a
// password kept by this installation's server (stack/passwords.mjs); an
// administrator adds them. Their role and access come from their users/{uid}
// profile. There is no registration and no external identity provider.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null) // { uid, getIdToken }
  const [profile, setProfile] = useState(null) // users/{uid} doc
  const [org, setOrg] = useState(null) // organization/profile doc (live)
  const [loading, setLoading] = useState(true)
  // Which modules this organization uses. Defaults to the full product until
  // an administrator writes the setting.
  const [moduleMap, setModuleMap] = useState(() => normalizeEntitlement(null))
  const [modulesReady, setModulesReady] = useState(false)

  const refreshProfile = useCallback(async (uid) => {
    const p = await getUserProfile(uid)
    setProfile(p)
    return p
  }, [])

  useEffect(() => {
    const uid = sessionUid()
    if (!uid) {
      setUser(null)
      setProfile(null)
      setLoading(false)
      return undefined
    }
    setUser({ uid, getIdToken: async () => currentAccessToken() })
    startSession()
    refreshProfile(uid)
      .catch(() => setProfile(null))
      .finally(() => setLoading(false))
    return undefined
  }, [refreshProfile])

  const approved = profile?.status === 'approved'

  // Keep the organization document live so any screen can read org-level
  // config (e.g. per-module scope granularity) without its own subscription.
  useEffect(() => {
    if (!approved) {
      setOrg(null)
      return undefined
    }
    return subscribeOrg(setOrg)
  }, [approved])

  // Only an APPROVED member may read the setting, so a pending or disabled
  // account must not subscribe.
  useEffect(() => {
    if (!approved) {
      setModuleMap(normalizeEntitlement(null))
      setModulesReady(true)
      return undefined
    }
    setModulesReady(false)
    return subscribeEntitlement((map) => {
      setModuleMap(map)
      setModulesReady(true)
    })
  }, [approved])

  const postAuth = async (path, payload) => {
    const gateway = ownStackGateway()
    if (!gateway) throw new Error('This site cannot reach its server.')
    const res = await fetch(`${gateway}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !(body.token || (body.mfa && body.ticket))) {
      const err = new Error(body.message || 'Sign-in was refused.')
      err.code = body.reason || 'unauthenticated'
      throw err
    }
    return body
  }

  /**
   * @returns {{ status: 'signed-in', user } | { status: 'code', ticket }} —
   * 'code' when two-step login is on: finish with loginWithCode. Throws with
   * the server's message on refusal.
   */
  const login = async ({ email, password } = {}) => {
    const body = await postAuth('/auth/password', { email, password })
    if (!body.token) return { status: 'code', ticket: body.ticket }
    return acceptToken(body.token)
  }

  /** The second step: the ticket from login and the authenticator's current code. */
  const loginWithCode = async ({ ticket, code } = {}) => {
    const body = await postAuth('/auth/totp', { ticket, code })
    return acceptToken(body.token)
  }

  const acceptToken = async (token) => {
    setAccessToken(token)
    const uid = sessionUid(token)
    const sessionUser = { uid, getIdToken: async () => token }
    setUser(sessionUser)
    startSession()
    await refreshProfile(uid)
    return { status: 'signed-in', user: sessionUser }
  }

  const signOut = async () => {
    // Every identity change drops the encryption keys and the cached rows: on a
    // shared site laptop the next person must not inherit either.
    clearKeyring()
    clearSharedSubscriptions()
    endSession()
    clearAccessToken()
    setUser(null)
    setProfile(null)
  }

  const role = profile?.role || null
  // What this person may open: the organization's modules, narrowed to the
  // ones granted to them. Every screen reads this map, so the sidebar, portal
  // grid and route gate all follow the grant.
  const personalMap = useMemo(() => personalModuleMap(moduleMap, profile), [moduleMap, profile])
  const value = {
    user,
    profile,
    org,
    loading,
    isAuthed: Boolean(user),
    isApproved: approved,
    role,
    isAdmin: role === 'admin',
    isManager: role === 'admin' || role === 'manager',
    isReadOnly: role === 'auditor',
    moduleMap: personalMap,
    orgModuleMap: moduleMap,
    modulesReady,
    moduleEnabled: (key) => isModuleEnabled(personalMap, key),
    orgModuleEnabled: (key) => isModuleEnabled(moduleMap, key),
    orgName: org?.name || '',
    actor: { uid: user?.uid, name: profile?.name || 'Unknown' },
    login,
    loginWithCode,
    signOut,
    refreshProfile: () => user && refreshProfile(user.uid),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
