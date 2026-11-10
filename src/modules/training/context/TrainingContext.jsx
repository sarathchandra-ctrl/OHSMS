import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../shared/auth/AuthContext'
import { subscribeOrgUsers, subscribeSites } from '../../../shared/org/orgData'
import { resolveAccessibleSites } from '../../../shared/auth/access'
import { subscribeCourses, subscribeRecords, subscribeAssignments } from '../lib/data'
import { summarize, summarizeAssignments, todayISO } from '../lib/status'

const TrainingContext = createContext(null)

/** Live org data for the Training module: courses, records, assignments, users, sites. */
export function TrainingProvider({ children }) {
  const { profile, isAdmin } = useAuth()
  const [courses, setCourses] = useState(null)
  const [records, setRecords] = useState(null)
  const [assignments, setAssignments] = useState(null)
  const [users, setUsers] = useState([])
  const [allSites, setAllSites] = useState([])

  useEffect(() => {
    const u1 = subscribeCourses(setCourses)
    const u2 = subscribeRecords(setRecords)
    const u3 = subscribeAssignments(setAssignments)
    const u4 = subscribeOrgUsers(setUsers)
    const u5 = subscribeSites(setAllSites)
    return () => { u1(); u2(); u3(); u4(); u5() }
  }, [])

  const value = useMemo(() => {
    const uid = profile?.uid
    const approvedUsers = users.filter((u) => u.status === 'approved')
    const siteInventory = resolveAccessibleSites(profile, allSites, { isAdmin })
    const allAssignments = assignments || []
    const openAssignments = allAssignments.filter((a) => a.status === 'assigned')
    return {
      loading: courses === null || records === null,
      courses: courses || [],
      records: records || [],
      assignments: allAssignments,
      openAssignments,
      // Learner (self-service) views
      myAssignments: openAssignments.filter((a) => a.employeeUid === uid),
      myRecords: (records || []).filter((r) => r.employeeUid === uid),
      users: approvedUsers,
      siteInventory,
      stats: summarize(records || [], todayISO()),
      assignmentStats: summarizeAssignments(allAssignments, todayISO()),
    }
  }, [courses, records, assignments, users, allSites, profile, isAdmin])

  return <TrainingContext.Provider value={value}>{children}</TrainingContext.Provider>
}

export function useTraining() {
  const ctx = useContext(TrainingContext)
  if (!ctx) throw new Error('useTraining must be used within TrainingProvider')
  return ctx
}
