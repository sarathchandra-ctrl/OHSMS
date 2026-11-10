import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from './AuthContext'
import { subscribeAssessments, subscribeOrg, subscribeActivity } from '../lib/data'
import { subscribeSites } from '../../../shared/org/orgData'
import { resolveAccessibleSites } from '../../../shared/auth/access'
import { summarize } from '../lib/raStats'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { AccessDenied } from '../../../shared/ui'

const RaContext = createContext(null)

/** One real-time listener for the org's risk assessments + org doc; pages read slices. */
export function RaProvider({ children }) {
  const { profile, isAdmin } = useAuth()
  const [assessments, setAssessments] = useState([])
  const [org, setOrg] = useState(null)
  const [activity, setActivity] = useState([])
  const [allSites, setAllSites] = useState([])
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    setLoading(true)
    setDenied(false)
    // If a listener is denied/fails, stop loading so the UI is not a spinner.
    // Permission-denied is an access check — empty, no toast. Anything else
    // (index, network) still gets one quiet connection toast.
    let warned = false
    const onErr = (err) => {
      setLoading(false)
      if (isPermissionDenied(err)) {
        setDenied(true)
        return
      }
      if (!warned) {
        warned = true
        toast.error('Could not load live data. Check your connection.')
      }
    }
    const u1 = subscribeAssessments(
      (list) => {
        setAssessments(list)
        setLoading(false)
      },
      onErr
    )
    const u2 = subscribeOrg(setOrg, onErr)
    const u3 = subscribeActivity(setActivity, onErr)
    const u4 = subscribeSites(setAllSites)
    return () => {
      u1()
      u2()
      u3()
      u4()
    }
  }, [])

  const siteInventory = useMemo(
    () => resolveAccessibleSites(profile, allSites, { isAdmin }),
    [allSites, profile, isAdmin]
  )

  const value = useMemo(
    () => ({
      loading,
      assessments,
      org,
      sites: org?.sites || [],
      siteInventory,
      activity,
      // Stats exclude baselines (they're activity templates, not live site risks).
      summary: summarize(assessments.filter((a) => a.kind !== 'baseline')),
    }),
    [assessments, org, siteInventory, activity, loading]
  )

  return (
    <RaContext.Provider value={value}>{denied ? <AccessDenied /> : children}</RaContext.Provider>
  )
}

export function useRa() {
  const ctx = useContext(RaContext)
  if (!ctx) throw new Error('useRa must be used within RaProvider')
  return ctx
}
