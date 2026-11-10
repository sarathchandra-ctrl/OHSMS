import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import {
  subscribeExtinguishers,
  subscribeReports,
  subscribeOrgUsers,
  subscribeOrg,
  subscribeStats,
  subscribeAuditLogs,
  subscribeSignages,
  subscribeMockDrills,
  subscribeAeds,
  subscribeFas,
  subscribeFirstAid,
  subscribeStretchers,
  subscribeDefectClosures,
  backfillDeletedAt,
} from '../lib/data'
import {
  fleetSummary,
  isToBeRefilled,
  isInProcess,
  isPhysicalDefect,
  isRefilledClosed,
  isDeleted,
} from '../lib/extinguisherLogic'
import { derivePhysicalDefectLog } from '../lib/defectReports'
import { aedCondition, fasCondition, stretcherCondition } from '../lib/assetLogic'
import { EXT_LOAD_CAP } from '../lib/data'
import { subscribeSites, incompleteReadNotice } from '../../../shared/org/orgData'
import { resolveAccessibleSites } from '../../../shared/auth/access'
import { useTodayKey } from '../../../shared/lib/useToday'
import { withSites } from '../lib/siteResolve'

const FleetContext = createContext(null)

/**
 * One set of real-time listeners for the whole authed app: extinguishers,
 * reports (approval queue), org users and the org document. Pages read derived
 * slices from here.
 */
export function FleetProvider({ children }) {
  const { profile, isAdmin } = useAuth()
  const [extinguishers, setExtinguishers] = useState([])
  const [allSites, setAllSites] = useState([])
  const [reports, setReports] = useState([])
  const [users, setUsers] = useState([])
  const [org, setOrg] = useState(null)
  const [stats, setStats] = useState(null)
  const [auditLogs, setAuditLogs] = useState([])
  const [signages, setSignages] = useState([])
  const [mockDrills, setMockDrills] = useState([])
  const [aeds, setAeds] = useState([])
  const [fas, setFas] = useState([])
  const [firstAid, setFirstAid] = useState([])
  const [stretchers, setStretchers] = useState([])
  const [defectClosures, setDefectClosures] = useState([])
  const [loading, setLoading] = useState(true)
  // Run the deletedAt backfill at most once per session.
  const backfilledRef = useRef(null)

  useEffect(() => {
    setLoading(true)
    let ready = false
    const done = () => {
      if (!ready) {
        ready = true
        setLoading(false)
      }
    }
    const u1 = subscribeExtinguishers((list) => {
      setExtinguishers(list)
      done()
      // One-time migration: make pre-soft-delete docs visible to the Repository's
      // server query (which filters deletedAt == null). Fire-and-forget; the
      // listener re-delivers the patched docs automatically.
      if (!backfilledRef.current && list.some((e) => e && e.deletedAt === undefined)) {
        backfilledRef.current = true
        backfillDeletedAt(list).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[Fire Marshal] deletedAt backfill failed:', err?.message || err)
        })
      }
    })
    const u2 = subscribeReports(setReports)
    const u3 = subscribeOrgUsers(setUsers)
    const u4 = subscribeOrg(setOrg)
    const u5 = subscribeStats(setStats)
    const u6 = subscribeAuditLogs(setAuditLogs)
    const u7 = subscribeSignages(setSignages)
    const u8 = subscribeMockDrills(setMockDrills)
    const u9 = subscribeAeds(setAeds)
    const u10 = subscribeFas(setFas)
    const u11 = subscribeSites(setAllSites)
    const u12 = subscribeFirstAid(setFirstAid)
    const u13 = subscribeStretchers(setStretchers)
    const u14 = subscribeDefectClosures(setDefectClosures)
    return () => {
      u1()
      u2()
      u3()
      u4()
      u5()
      u6()
      u7()
      u8()
      u9()
      u10()
      u11()
      u12()
      u13()
      u14()
    }
  }, [])

  // Sites the current user is permitted for (correlated Region/Entity/Site picker).
  const siteInventory = useMemo(
    () => resolveAccessibleSites(profile, allSites, { isAdmin }),
    [allSites, profile, isAdmin]
  )

  // The calendar day is a DEPENDENCY, not something read once. Every derived
  // state below — Refill Due, HPT overdue, the physical-defect count — is
  // computed here from `today`, and the memo only re-ran when the DATA changed.
  // A dashboard left on a wall therefore kept reporting yesterday's answer
  // until somebody edited an unrelated unit.
  const todayKey = useTodayKey()

  const value = useMemo(() => {
    const today = new Date()
    // Soft-deleted units live in the Recycle Bin only — exclude everywhere else.
    // Fill in center/region/entity from the site registry wherever a unit left
    // them blank. Units added by import, or before their site existed, carry
    // only a siteId — their rows showed an empty Entity and Center, which reads
    // as "never captured" when the site is known and one lookup away. Nothing is
    // written: the asset's own values always win, and the link-to-sites action
    // keeps its job of persisting them.
    const active = withSites(extinguishers.filter((e) => !isDeleted(e)), allSites)
    const deletedExtinguishers = extinguishers.filter((e) => isDeleted(e))
    // AEDs and fire-alarm panels share the extinguisher bin. A missing
    // deletedAt is in service, so a register written before the field existed
    // does not disappear.
    const activeAeds = aeds.filter((a) => !isDeleted(a))
    const activeFas = fas.filter((a) => !isDeleted(a))
    const deletedAeds = aeds.filter((a) => isDeleted(a))
    const deletedFas = fas.filter((a) => isDeleted(a))
    const deletedExtIds = new Set(deletedExtinguishers.map((e) => e.id))
    const deletedAedIds = new Set(deletedAeds.map((a) => a.id))
    const deletedFasIds = new Set(deletedFas.map((a) => a.id))
    const summary = fleetSummary(active, today)
    const defectLog = derivePhysicalDefectLog(reports, active)
    // Distinct site names (centerName) seen anywhere — used to populate the
    // site filters / datalists on the signage + mock-drill pages.
    const sites = Array.from(
      new Set(
        [
          ...active.map((e) => e.centerName),
          ...signages.map((s) => s.centerName),
          ...mockDrills.map((d) => d.centerName),
          ...activeAeds.map((a) => a.centerName),
          ...activeFas.map((a) => a.centerName),
          ...firstAid.map((r) => r.centerName),
          ...stretchers.map((a) => a.centerName),
        ].filter((c) => c && c.trim())
      )
    ).sort((a, b) => a.localeCompare(b))
    return {
      loading,
      org,
      stats,
      auditLogs,
      signages,
      mockDrills,
      aeds: activeAeds,
      fas: activeFas,
      deletedAeds,
      deletedFas,
      firstAid,
      stretchers,
      stretchersDue: stretchers.filter((a) => { const c = stretcherCondition(a, today); return c.due || c.expired }).length,
      aedsDue: activeAeds.filter((a) => { const c = aedCondition(a, today); return c.due || c.expired }).length,
      fasDue: activeFas.filter((a) => { const c = fasCondition(a, today); return c.due || c.expired }).length,
      sites,
      siteInventory,
      extinguishers: active,
      deletedExtinguishers,
      // True when the live load hit the cap (full set may be larger).
      capped: extinguishers.length >= EXT_LOAD_CAP,
      loadCap: EXT_LOAD_CAP,
      // Every capped register in this module, in the app's standard shape.
      //
      // `capped` above covers extinguishers alone, and the Dashboard's banner
      // said "the most recent 2 000 extinguishers" while the same page's AED,
      // FAS, signage, first aid, stretcher and drill figures were being
      // truncated in silence beside it. A caveat that names one short number of
      // several is worse than none: it reads as an assurance about the rest.
      incomplete: incompleteReadNotice({
        extinguishers: extinguishers.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        aeds: aeds.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        fas: fas.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        signages: signages.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        firstAid: firstAid.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        stretchers: stretchers.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        mockDrills: mockDrills.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        reports: reports.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
        defectClosures: defectClosures.length >= EXT_LOAD_CAP ? 'capped' : 'ok',
      }, EXT_LOAD_CAP),
      defectClosures,
      reports,
      users,
      summary,
      // A defect on a unit in the bin is not work. The report document stays
      // (it is the history); it just does not sit in the queue until the unit
      // comes back.
      pendingReports: reports.filter((r) => {
        if (r.approvalStatus !== 'pending' || r.deletedAt) return false
        if (r.kind === 'defect' && deletedExtIds.has(r.extId)) return false
        if (r.kind === 'asset_defect' && r.assetKind === 'aed' && deletedAedIds.has(r.assetRefId)) return false
        if (r.kind === 'asset_defect' && r.assetKind === 'fas' && deletedFasIds.has(r.assetRefId)) return false
        return true
      }),
      pendingUsers: users.filter((u) => u.status === 'pending'),
      refillDue: active.filter((e) => isToBeRefilled(e, today)),
      inProcess: active.filter((e) => isInProcess(e)),
      physicalDefects: active.filter((e) => isPhysicalDefect(e)),
      closed: active.filter((e) => isRefilledClosed(e)),
      physicalOpen: defectLog.open,
      physicalClosed: defectLog.closed,
    }
  }, [extinguishers, reports, users, org, stats, auditLogs, signages, mockDrills, aeds, fas, firstAid, stretchers, defectClosures, allSites, siteInventory, loading, todayKey])

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>
}

export function useFleet() {
  const ctx = useContext(FleetContext)
  if (!ctx) throw new Error('useFleet must be used within FleetProvider')
  return ctx
}
