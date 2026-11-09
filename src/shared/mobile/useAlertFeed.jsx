import { useEffect, useMemo, useState } from 'react'
import { doc, onSnapshot, serverTimestamp, setDoc } from '../data/client.js'
import toast from 'react-hot-toast'
import { db } from '../db'
import { useAuth } from '../auth/AuthContext'
import { isModuleEnabled } from '../modules/entitlements'
import { useAccessibleSitesRead } from '../org/useAccessibleSites'
import {
  subscribeAeds,
  subscribeExtinguishers,
  subscribeFas,
  subscribeMockDrills,
  subscribeReports,
  subscribeStretchers,
} from '../../modules/fire/lib/firestore'
import { subscribeIncidents } from '../../modules/incidents/lib/incidents'
import { subscribeConsultations } from '../../modules/committee/lib/firestore'
import { useAllSiteWeather } from '../../modules/weather/lib/useAllSiteWeather'
import { AlertFeedProviderContext } from './alertContext'
import {
  buildAlertFeed,
  nextReadIds,
  parseReadIds,
  serializeReadIds,
  unreadCount,
} from './alertsFeed'

// A listener that only logs its failure (mock drills) would leave this screen
// spinning. If nothing has answered after this long, show the rows that did.
const LISTENER_GIVE_UP_MS = 12_000

function useRows(active, subscribe, { signalError = false } = {}) {
  const [rows, setRows] = useState([])
  const [ready, setReady] = useState(!active)

  useEffect(() => {
    if ((!active)) {
      setRows([])
      setReady(!active)
      return undefined
    }
    setReady(false)
    let settled = false
    const finish = (next) => {
      settled = true
      setRows(Array.isArray(next) ? next : [])
      setReady(true)
    }
    // The third argument is not free. subscribeExtinguishers and
    // subscribeIncidents read it as a page size, so a function there makes
    // limit() throw and the feed never loads. Only the meeting listener
    // takes an error callback in that position.
    const unsub = signalError
      ? subscribe(finish, () => finish([]))
      : subscribe(finish)
    const timer = setTimeout(() => {
      if (!settled) finish([])
    }, LISTENER_GIVE_UP_MS)
    return () => {
      clearTimeout(timer)
      unsub?.()
    }
  }, [active, subscribe, signalError])

  return { rows, ready }
}

function useAlertState(enabled) {
  const { user, moduleMap, isApproved } = useAuth()
  const uid = user?.uid || ''
  const live = Boolean(enabled && uid && isApproved)
  const { sites, status: sitesStatus } = useAccessibleSitesRead()

  const equipment = live && isModuleEnabled(moduleMap, 'equipment')
  const incidentsOn = live && isModuleEnabled(moduleMap, 'incidents')
  const committeeOn = live && isModuleEnabled(moduleMap, 'committee')
  const drillsOn = live && isModuleEnabled(moduleMap, 'drills')
  const weatherOn = live && isModuleEnabled(moduleMap, 'weather')

  const reports = useRows(equipment, subscribeReports)
  const extinguishers = useRows(equipment, subscribeExtinguishers)
  const aeds = useRows(equipment, subscribeAeds)
  const fas = useRows(equipment, subscribeFas)
  const stretchers = useRows(equipment, subscribeStretchers)
  const incidentRows = useRows(incidentsOn, subscribeIncidents)
  const meetingRows = useRows(committeeOn, subscribeConsultations, { signalError: true })
  const drillRows = useRows(drillsOn, subscribeMockDrills)

  const weather = useAllSiteWeather(weatherOn ? sites : [])
  const weatherBySiteId = useMemo(() => {
    const out = {}
    for (const [id, row] of Object.entries(weather.byId || {})) {
      out[id] = row?.risk
        ? { ...row.risk, observedAt: row.obs?.observedAt || '', slot: row.obs?.slot || '' }
        : row?.risk
    }
    return out
  }, [weather.byId])

  const [storedIds, setStoredIds] = useState('')
  const [pendingIds, setPendingIds] = useState(null)
  const [readsReady, setReadsReady] = useState(!live)

  useEffect(() => {
    if (!live) {
      setStoredIds('')
      setPendingIds(null)
      setReadsReady(!live)
      return undefined
    }
    setReadsReady(false)
    return onSnapshot(
      doc(db, 'alertReads', uid),
      (snap) => {
        setStoredIds(snap.exists() ? snap.data()?.ids || '' : '')
        setReadsReady(true)
      },
      () => {
        // The cursor is convenience. A rules deploy that has not landed yet
        // must not hide the feed; every row simply stays unread.
        setStoredIds('')
        setReadsReady(true)
      }
    )
  }, [live, uid])

  const readIds = useMemo(() => parseReadIds(pendingIds ?? storedIds), [pendingIds, storedIds])

  const items = useMemo(
    () =>
      buildAlertFeed({
        sites,
        reports: reports.rows,
        assets: {
          extinguishers: extinguishers.rows,
          aeds: aeds.rows,
          fas: fas.rows,
          stretchers: stretchers.rows,
        },
        incidents: incidentRows.rows,
        meetings: meetingRows.rows,
        drills: drillRows.rows,
        weatherBySiteId,
        enabled: {
          equipment,
          incidents: incidentsOn,
          committee: committeeOn,
          drills: drillsOn,
          weather: weatherOn,
        },
        readIds,
      }),
    [
      sites,
      reports.rows,
      extinguishers.rows,
      aeds.rows,
      fas.rows,
      stretchers.rows,
      incidentRows.rows,
      meetingRows.rows,
      drillRows.rows,
      weatherBySiteId,
      equipment,
      incidentsOn,
      committeeOn,
      drillsOn,
      weatherOn,
      readIds,
    ]
  )

  const sourcesReady =
    reports.ready &&
    extinguishers.ready &&
    aeds.ready &&
    fas.ready &&
    stretchers.ready &&
    incidentRows.ready &&
    meetingRows.ready &&
    drillRows.ready &&
    readsReady &&
    sitesStatus !== 'pending'

  const write = async (mark) => {
    if (!live) return
    const next = nextReadIds(
      readIds,
      items.map((row) => row.id),
      mark
    )
    const serial = serializeReadIds(next)
    setPendingIds(serial)
    try {
      await setDoc(doc(db, 'alertReads', uid), {
        ids: serial,
        updatedAt: serverTimestamp(),
      })
      setPendingIds(null)
    } catch {
      setPendingIds(null)
      toast.error('Could not update what you have read.')
    }
  }

  return {
    items,
    unread: unreadCount(items),
    ready: sourcesReady,
    markRead: (id) => write(id),
    markAllRead: () => write('*'),
  }
}

export function AlertProvider({ enabled, children }) {
  const value = useAlertState(enabled)
  return <AlertFeedProviderContext value={value}>{children}</AlertFeedProviderContext>
}
