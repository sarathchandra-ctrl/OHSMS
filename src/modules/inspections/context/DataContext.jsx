import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  subscribeTemplates,
  subscribeRecords,
  subscribeOrgUsers,
  subscribeSites,
} from '../lib/firestore'
import { buildScheduledTasks, formatDateOnly, normalizeTemplateFields } from '../lib/schedule'

const DataContext = createContext(null)

/** Live org-scoped data: inspection templates, records, members, sites. Derives
 *  the scheduled-task list for the current month and applies the active site
 *  filter to tasks + records so every consuming page is scoped consistently. */
export function DataProvider({ children }) {
  const [templates, setTemplates] = useState([])
  const [records, setRecords] = useState([])
  const [users, setUsers] = useState([])
  const [sites, setSites] = useState([])
  const [loading, setLoading] = useState(true)
  const [currentMonth, setCurrentMonth] = useState(() => new Date())
  // 'All' or a site id. Scopes Schedule / Overdue / Records / Dashboard.
  const [siteFilter, setSiteFilter] = useState('All')

  useEffect(() => {
    setLoading(true)
    const unsubs = [
      subscribeTemplates((list) => {
        setTemplates(list.map((t) => ({ ...t, fields: normalizeTemplateFields(t.fields || []) })))
        setLoading(false)
      }),
      subscribeRecords(setRecords),
      subscribeOrgUsers(setUsers),
      subscribeSites(setSites),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  // If the selected site disappears (deleted), fall back to All.
  useEffect(() => {
    if (siteFilter !== 'All' && !sites.some((s) => s.id === siteFilter)) setSiteFilter('All')
  }, [sites, siteFilter])

  const allTasks = useMemo(
    () => buildScheduledTasks({ templates, records, currentMonth }),
    [templates, records, currentMonth]
  )

  const scheduledTasks = useMemo(
    () => (siteFilter === 'All' ? allTasks : allTasks.filter((t) => t.siteId === siteFilter)),
    [allTasks, siteFilter]
  )

  const filteredRecords = useMemo(
    () => (siteFilter === 'All' ? records : records.filter((r) => r.siteId === siteFilter)),
    [records, siteFilter]
  )

  const todayString = formatDateOnly(new Date())

  const overdueTasks = useMemo(
    () => scheduledTasks.filter((t) => t.dueString < todayString),
    [scheduledTasks, todayString]
  )

  const dueTodayTasks = useMemo(
    () => scheduledTasks.filter((t) => t.dueString === todayString),
    [scheduledTasks, todayString]
  )

  const pendingUsers = useMemo(() => users.filter((u) => u.status === 'pending'), [users])
  const activeTemplates = useMemo(() => templates.filter((t) => t.status === 'Active'), [templates])

  const value = {
    loading,
    templates,
    activeTemplates,
    records,
    filteredRecords,
    users,
    pendingUsers,
    sites,
    siteFilter,
    setSiteFilter,
    scheduledTasks,
    overdueTasks,
    dueTodayTasks,
    currentMonth,
    setCurrentMonth,
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
