import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import {
  subscribePermits,
  subscribeObservations,
  subscribeOrgUsers,
  subscribeOrg,
  reconcilePermitStatus,
} from '../lib/data'
import { derivePermitStatus, STATUS } from '../lib/permitStatus'
import { openUnsafeByPermit } from '../lib/observations'
import { canActForTeam, TEAMS } from '../lib/permissions'

const PermitContext = createContext(null)

/** One set of real-time listeners for the authed app: permits, users, org. */
export function PermitProvider({ children }) {
  const { profile, isApprover } = useAuth()
  const [permits, setPermits] = useState([])
  const [observations, setObservations] = useState([])
  const [users, setUsers] = useState([])
  const [org, setOrg] = useState(null)
  const [loading, setLoading] = useState(true)
  const reconciledRef = useRef(new Set())

  useEffect(() => {
    setLoading(true)
    let ready = false
    const done = () => { if (!ready) { ready = true; setLoading(false) } }
    const u1 = subscribePermits((list) => { setPermits(list); done() })
    const u2 = subscribeOrgUsers(setUsers)
    const u4 = subscribeObservations(setObservations)
    const u3 = subscribeOrg(setOrg)
    return () => { u1(); u2(); u3(); u4() }
  }, [])

  // Auto-expire: persist storedStatus for permits whose live status drifted
  // (e.g. 8h window elapsed → Not Closed). Only approvers can write; once per
  // permit/status per session to avoid write storms.
  useEffect(() => {
    if ((!isApprover)) return
    const now = Date.now()
    for (const p of permits) {
      const live = derivePermitStatus(p, now)
      if (p.storedStatus !== live) {
        const key = `${p.id}:${live}`
        if (!reconciledRef.current.has(key)) {
          reconciledRef.current.add(key)
          reconcilePermitStatus(p)
        }
      }
    }
  }, [permits, isApprover])

  const value = useMemo(() => {
    const now = Date.now()
    // Unanswered unsafe reports, joined on so the status can reflect them. They
    // live in their own collection because the person raising one from a QR
    // scan has no permission to touch the permit.
    const openUnsafe = openUnsafeByPermit(observations)
    const withStatus = permits.map((p) => {
      const merged = { ...p, openUnsafeCount: openUnsafe.get(p.id) || 0 }
      return { ...merged, status: derivePermitStatus(merged, now) }
    })
    // Permits awaiting THIS user's team decision (and assigned to them, if assigned).
    const approvalQueue = withStatus.filter((p) => {
      if (p.status === STATUS.CLOSED) return false
      const engPending = p.engineering?.status === 'pending' && canActForTeam(profile, p, TEAMS.ENGINEERING)
      const opsPending = p.operations?.status === 'pending' && canActForTeam(profile, p, TEAMS.OPERATIONS)
      const bothTeamApproved = p.engineering?.status === 'approved' && p.operations?.status === 'approved'
      const closurePending = p.closure && (
        (p.closure.engineering?.status === 'pending' && canActForTeam(profile, p, TEAMS.ENGINEERING)) ||
        (p.closure.operations?.status === 'pending' && canActForTeam(profile, p, TEAMS.OPERATIONS))
      )
      const extPending = p.extension && (
        (p.extension.engineering?.status === 'pending' && canActForTeam(profile, p, TEAMS.ENGINEERING)) ||
        (p.extension.operations?.status === 'pending' && canActForTeam(profile, p, TEAMS.OPERATIONS))
      )
      return engPending || opsPending || (bothTeamApproved && (closurePending || extPending))
    })
    return {
      loading,
      org,
      sites: org?.sites || [],
      users,
      permits: withStatus,
      pendingUsers: users.filter((u) => u.status === 'pending'),
      approvalQueue,
      observations,
    }
  }, [permits, observations, users, org, loading, profile])

  return <PermitContext.Provider value={value}>{children}</PermitContext.Provider>
}

export function usePermits() {
  const ctx = useContext(PermitContext)
  if (!ctx) throw new Error('usePermits must be used within PermitProvider')
  return ctx
}
