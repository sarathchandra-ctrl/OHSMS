import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import {
  subscribePermits,
  subscribeObservations,
  subscribeOrgUsers,
  subscribeOrg,
  reconcilePermitStatus,
  subscribeProcedureLock,
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
  // procedureId -> live lock fields, for the LOTO procedures electrical
  // permits name (lib/lotoLink.js). A permit is LOTO pending until its
  // procedure is locked, and that state lives on the procedure, not the permit.
  const [locks, setLocks] = useState({})

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

  const procedureIds = useMemo(
    () => [...new Set(permits.map((p) => p.lotoProcedureId).filter(Boolean))].sort().join('|'),
    [permits],
  )
  useEffect(() => {
    const ids = procedureIds ? procedureIds.split('|') : []
    const offs = ids.map((id) =>
      subscribeProcedureLock(id, (fields) => setLocks((prev) => ({ ...prev, [id]: fields }))))
    return () => offs.forEach((off) => off())
  }, [procedureIds])

  // Each permit with its procedure's lock state, once that has loaded.
  const joined = useMemo(
    () => permits.map((p) => (p.lotoProcedureId && locks[p.lotoProcedureId] ? { ...p, ...locks[p.lotoProcedureId] } : p)),
    [permits, locks],
  )

  // Auto-expire: persist storedStatus for permits whose live status drifted
  // (e.g. 8h window elapsed → Not Closed). Only approvers can write; once per
  // permit/status per session to avoid write storms.
  useEffect(() => {
    if ((!isApprover)) return
    const now = Date.now()
    for (const p of joined) {
      // Not before its lock state has loaded: a guess would be written as fact.
      if (p.lotoProcedureId && !locks[p.lotoProcedureId]) continue
      const live = derivePermitStatus(p, now)
      if (p.storedStatus !== live) {
        const key = `${p.id}:${live}`
        if (!reconciledRef.current.has(key)) {
          reconciledRef.current.add(key)
          reconcilePermitStatus(p)
        }
      }
    }
  }, [joined, locks, isApprover])

  const value = useMemo(() => {
    const now = Date.now()
    // Unanswered unsafe reports, joined on so the status can reflect them. They
    // live in their own collection because the person raising one from a QR
    // scan has no permission to touch the permit.
    const openUnsafe = openUnsafeByPermit(observations)
    const withStatus = joined.map((p) => {
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
  }, [joined, observations, users, org, loading, profile])

  return <PermitContext.Provider value={value}>{children}</PermitContext.Provider>
}

export function usePermits() {
  const ctx = useContext(PermitContext)
  if (!ctx) throw new Error('usePermits must be used within PermitProvider')
  return ctx
}
