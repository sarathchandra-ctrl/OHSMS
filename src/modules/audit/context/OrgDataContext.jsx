import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext'
import { subscribeSites } from '../services/sites'
import { subscribeAudits } from '../services/audits'
import { subscribeFindings } from '../services/findings'
import { subscribeCapas } from '../services/capa'
import { subscribeOrgUsers } from '../services/users'
import { subscribeOrg } from '../../../shared/org/orgData'
import { resolveAccessibleSites } from '../../../shared/auth/access'

const OrgDataContext = createContext(null)

/**
 * Subscribes once to all org-scoped collections and shares them across the
 * authenticated app, so pages stay in real-time sync without duplicate
 * listeners. Mounted inside the protected app shell.
 */
export function OrgDataProvider({ children }) {
  const { profile, isAdmin } = useAuth()

  const [sites, setSites] = useState([])
  const [audits, setAudits] = useState([])
  const [findings, setFindings] = useState([])
  const [capas, setCapas] = useState([])
  const [users, setUsers] = useState([])
  const [org, setOrg] = useState(null)

  useEffect(() => {
    const unsubs = [
      subscribeSites(setSites),
      subscribeAudits(setAudits),
      subscribeFindings(setFindings),
      subscribeCapas(setCapas),
      subscribeOrgUsers(setUsers),
      subscribeOrg(setOrg),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  // Convenience lookups by id.
  const value = useMemo(() => {
    const siteById = Object.fromEntries(sites.map((s) => [s.id, s]))
    const userById = Object.fromEntries(users.map((u) => [u.id, u]))
    const auditById = Object.fromEntries(audits.map((a) => [a.id, a]))
    const findingById = Object.fromEntries(findings.map((f) => [f.id, f]))
    return {
      org,
      locations: org?.locations || [],
      sites,
      siteInventory: resolveAccessibleSites(profile, sites, { isAdmin }),
      audits,
      findings,
      capas,
      users,
      siteById,
      userById,
      auditById,
      findingById,
    }
  }, [org, sites, audits, findings, capas, users, profile, isAdmin])

  return (
    <OrgDataContext.Provider value={value}>{children}</OrgDataContext.Provider>
  )
}

export function useOrgData() {
  const ctx = useContext(OrgDataContext)
  if (!ctx) throw new Error('useOrgData must be used within an OrgDataProvider')
  return ctx
}
