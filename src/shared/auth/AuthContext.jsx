import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { clearKeyring } from '../crypto'
import { clearSharedSubscriptions } from '../org/sharedSubscription'
import { startSession, endSession } from './sessionConstants'
import {
  normalizeEntitlement,
  subscribeEntitlement,
  isModuleEnabled,
} from '../modules/entitlements'
import { getUserProfile, subscribeOrg } from '../org/orgData'
import {
  adoptSessionFromHash,
  clearAccessToken,
  currentAccessToken,
  ownStackAuthMethod,
  ownStackGateway,
  sessionUid,
  setAccessToken,
} from './ownStackSession'

const AuthContext = createContext(null)

// One organization per installation. Who someone is comes from the identity
// provider connected at /setup (OIDC, SAML or Supabase Auth); whether they
// belong, and as what, comes from their users/{uid} profile on this server's
// database (stack/identity.mjs). There is no registration, no "join an
// organization" and no platform operator in this build.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null) // { uid, getIdToken }
  const [profile, setProfile] = useState(null) // users/{uid} doc
  const [org, setOrg] = useState(null) // organization/profile doc (live)
  const [loading, setLoading] = useState(true)
  // Which modules this organization uses. Defaults to the full product until
  // an administrator writes the setting.
  const [moduleMap, setModuleMap] = useState(() => normalizeEntitlement(null))
  const [modulesReady, setModulesReady] = useState(false)

  // During render, not in the effect below: a child's <Navigate> runs its
  // effect first and would strip the fragment. See adoptSessionFromHash.
  useState(() => adoptSessionFromHash())

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

  /** @returns {{ status: 'signed-in' | 'redirecting', user? }} */
  const login = async ({ email, password } = {}) => {
    const gateway = ownStackGateway()
    if (!gateway) throw new Error('This server has no sign-in host configured.')
    if (ownStackAuthMethod() === 'supabase') {
      const res = await fetch(`${gateway}/auth/supabase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) throw new Error('Sign-in was refused.')
      const { token } = await res.json()
      setAccessToken(token)
      const uid = sessionUid(token)
      const sessionUser = { uid, getIdToken: async () => token }
      setUser(sessionUser)
      startSession()
      await refreshProfile(uid)
      return { status: 'signed-in', user: sessionUser }
    }
    // Company OIDC or SAML: the server starts the round trip and brings the
    // browser back with /#session=<token>.
    window.location.assign(`${gateway}/auth/start`)
    return { status: 'redirecting' }
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
    moduleMap,
    modulesReady,
    moduleEnabled: (key) => isModuleEnabled(moduleMap, key),
    orgName: org?.name || '',
    actor: { uid: user?.uid, name: profile?.name || 'Unknown' },
    login,
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
