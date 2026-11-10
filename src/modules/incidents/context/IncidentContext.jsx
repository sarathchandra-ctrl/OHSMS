import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext'
import { subscribeOrgUsers, subscribeOrg } from '../lib/data'
import { subscribeSites } from '../../../shared/org/orgData'
import { resolveAccessibleSites } from '../../../shared/auth/access'
import { subscribeIncidents, subscribeStats, INCIDENT_LOAD_CAP } from '../lib/incidents'
import { subscribeIllnesses } from '../lib/illnesses'
import { subscribeInjuries, injuryStatus } from '../lib/injuries'
import { flattenActions, isActionOverdue, todayISO } from '../lib/actions'

const IncidentContext = createContext(null)

/**
 * One real-time listener set for the whole authed app: incidents, illnesses,
 * org users, the org doc and the stats counter. Pages read derived slices from
 * here. NO photo/file listeners — those load per-record on open. Mirrors Fire
 * Marshal's FleetContext.
 */
export function IncidentProvider({ children }) {
  const { user, profile, isAdmin, isInvestigator } = useAuth()
  const [incidents, setIncidents] = useState([])
  const [illnesses, setIllnesses] = useState([])
  const [injuries, setInjuries] = useState([])
  const [users, setUsers] = useState([])
  const [allSites, setAllSites] = useState([])
  const [org, setOrg] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  // Injuries and illnesses carry a named colleague's body parts, injury type,
  // medication and days off. The rules restrict them to admin and manager; this
  // stops everyone else opening a listener that can only ever be refused, which
  // would fill the console with permission errors on a page that is working
  // correctly and make the real ones harder to see.
  //
  // isInvestigator, not profile.role: this module renames the platform's roles
  // for its own permission matrix (manager → investigator, AuthContext.jsx), so
  // comparing profile.role against 'manager' was false for every manager alive —
  // silently, because a manager saw the same empty health data a member did. It
  // matters more now that these collections are the only copy.
  const canReadHealth = isAdmin || isInvestigator

  useEffect(() => {
    setLoading(true)
    let ready = false
    const done = () => { if (!ready) { ready = true; setLoading(false) } }
    const u1 = subscribeIncidents((list) => { setIncidents(list); done() })
    const u3 = subscribeOrgUsers(setUsers)
    const u4 = subscribeOrg(setOrg)
    const u5 = subscribeStats(setStats)
    const u7 = subscribeSites(setAllSites)
    const noop = () => {}
    const u2 = canReadHealth ? subscribeIllnesses(setIllnesses) : noop
    const u6 = canReadHealth ? subscribeInjuries(setInjuries) : noop
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); u7() }
  }, [canReadHealth])

  // Sites the current user is permitted to log incidents against.
  const sites = useMemo(
    () => resolveAccessibleSites(profile, allSites, { isAdmin }),
    [allSites, profile, isAdmin]
  )

  const value = useMemo(() => {
    const today = todayISO()
    const active = incidents.filter((i) => !i.deletedAt)
    const deletedIncidents = incidents.filter((i) => i.deletedAt)
    const activeIll = illnesses.filter((i) => !i.deletedAt)
    const deletedIllnesses = illnesses.filter((i) => i.deletedAt)

    const allActions = flattenActions(active, activeIll)
    const openActions = allActions.filter((a) => a.status !== 'closed')
    const overdueActions = allActions.filter((a) => isActionOverdue(a, today))
    const myAssignedActions = allActions.filter((a) => a.ownerUid && a.ownerUid === user?.uid && a.status !== 'closed')

    // Body-part aggregate (injuries + illnesses) for the dashboard heatmap.
    //
    // Injury body parts are read from /injuries now, not from
    // incident.injuryReports — that array was how a named colleague's body parts
    // reached every approved member and the external auditor. Both sources are
    // manager-gated, which also settles an inconsistency: illness body parts
    // already came from the gated collection while injury ones came from the
    // open one. Anyone who cannot read them gets {} here, and the dashboard says
    // so rather than drawing an empty body.
    // subscribeInjuries emits deleted rows too now, so the split happens here —
    // beside the two that already did it — rather than inside the listener.
    // Every existing consumer of `injuries` means the active ones, so that name
    // keeps that meaning and the bin gets its own.
    const activeInjuries = injuries.filter((i) => !i.deletedAt)
    const deletedInjuries = injuries.filter((i) => i.deletedAt)

    const activeIncidentIds = new Set(active.map((i) => i.id))
    const bodyPartCounts = {}
    for (const inj of activeInjuries) {
      // An injury whose incident is in the recycle bin is not counted, matching
      // what the incident-side aggregate did before.
      if (inj.incidentId && !activeIncidentIds.has(inj.incidentId)) continue
      for (const key of inj.bodyParts || []) bodyPartCounts[key] = (bodyPartCounts[key] || 0) + 1
    }
    for (const ill of activeIll) {
      for (const key of ill.affectedBodyParts || []) bodyPartCounts[key] = (bodyPartCounts[key] || 0) + 1
    }

    const pendingInjuries = activeInjuries.filter((i) => injuryStatus(i) !== 'verified')

    return {
      loading,
      org,
      stats,
      users,
      sites,
      // Every screen that shows injury or illness detail has to be able to tell
      // "nothing recorded" from "not yours to see", so the flag travels with the
      // data rather than being re-derived from roles at each one.
      canReadHealth,
      pendingUsers: users.filter((u) => u.status === 'pending'),
      incidents: active,
      deletedIncidents,
      illnesses: activeIll,
      deletedIllnesses,
      injuries: activeInjuries,
      deletedInjuries,
      pendingInjuries,
      allActions,
      openActions,
      overdueActions,
      myAssignedActions,
      bodyPartCounts,
      capped: incidents.length >= INCIDENT_LOAD_CAP,
      loadCap: INCIDENT_LOAD_CAP,
    }
  }, [incidents, illnesses, injuries, users, sites, org, stats, loading, user, canReadHealth])

  return <IncidentContext.Provider value={value}>{children}</IncidentContext.Provider>
}

export function useIncidents() {
  const ctx = useContext(IncidentContext)
  if (!ctx) throw new Error('useIncidents must be used within IncidentProvider')
  return ctx
}
