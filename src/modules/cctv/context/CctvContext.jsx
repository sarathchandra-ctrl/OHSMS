import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../shared/auth/AuthContext'
import { subscribeSites } from '../../../shared/org/orgData'
import { subscribeCameras, subscribeDvrs, subscribeMerakis } from '../lib/data'
import { estateHealth } from '../lib/health'
import { isPermissionDenied } from '../../../shared/lib/permissionDenied'
import { AccessDenied } from '../../../shared/ui'
import {
  siteMeta,
  scopeEstate,
  scopeFacets,
  narrowSites,
  reconcileScope,
  isScoped,
  filterByScope,
} from '../lib/filters'

const Ctx = createContext(null)

/**
 * One subscription set for the whole module, and one health pass over it.
 *
 * The three collections are useless apart — a camera's status is meaningless
 * without knowing whether its DVR is up — so every page needs all three and
 * subscribing per page would mean three listeners each and a health calculation
 * that disagrees between tabs.
 */
export function CctvProvider({ children }) {
  const { orgName } = useAuth()
  const [cameras, setCameras] = useState([])
  const [dvrs, setDvrs] = useState([])
  const [merakis, setMerakis] = useState([])
  const [sites, setSites] = useState([])
  const [loaded, setLoaded] = useState({ cameras: false, dvrs: false, merakis: false })
  const [error, setError] = useState(null)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    setLoaded({ cameras: false, dvrs: false, merakis: false })
    setError(null)
    setDenied(false)

    // A listener that fails hands back null. Showing an empty estate then would
    // read as "no cameras installed" rather than "we could not load them", so
    // a real fault is kept and the pages say so. Permission-denied is the
    // viewer not being allowed the estate — empty, and the shell shows AccessDenied.
    const bind = (subscribe, set, key) =>
      subscribe((rows, err) => {
        if (err) {
          if (isPermissionDenied(err)) {
            set([])
            setDenied(true)
            setLoaded((l) => ({ ...l, [key]: true }))
            return
          }
          return setError(err)
        }
        set(rows || [])
        setLoaded((l) => ({ ...l, [key]: true }))
      })

    const unsubs = [
      bind(subscribeCameras, setCameras, 'cameras'),
      bind(subscribeDvrs, setDvrs, 'dvrs'),
      bind(subscribeMerakis, setMerakis, 'merakis'),
      subscribeSites((rows) => setSites(rows || [])),
    ]
    return () => unsubs.forEach((u) => u?.())
  }, [])

  // Recomputed only when the inputs change — the cascade walks every device
  // three times and pages re-render on every keystroke in a filter box.
  const estate = useMemo(() => estateHealth({ cameras, dvrs, merakis }), [cameras, dvrs, merakis])

  // Site/entity/region scope, shared by every tab: switching from Health to
  // Defects while investigating one region and silently seeing the whole estate
  // again is how a number gets quoted for the wrong thing.
  //
  // Held in the URL rather than in state, for a reason that is not cosmetic:
  // AppChrome keys its page wrapper on location.pathname to run the route
  // transition, so EVERY module below it is remounted when the path changes.
  // React state here would be wiped on each tab switch — which is exactly what
  // it did before this. The query string survives that by definition, and a
  // filtered view becomes something you can send to someone.
  const [params, setParams] = useSearchParams()
  const meta = useMemo(() => siteMeta(sites), [sites])

  const scope = useMemo(
    () => ({
      siteId: params.get('site') || '',
      entity: params.get('entity') || '',
      region: params.get('region') || '',
    }),
    [params]
  )

  // Every change is reconciled, because choosing a region can strand a site
  // outside it and an empty page reads as "nothing here" rather than
  // "impossible combination".
  const setScope = useMemo(
    () => (patch) => {
      const next = reconcileScope({ ...scope, ...patch }, sites)
      const p = new URLSearchParams(params)
      const put = (key, value) => (value ? p.set(key, value) : p.delete(key))
      put('site', next.siteId)
      put('entity', next.entity)
      put('region', next.region)
      // replace, not push: adjusting a filter should not bury the previous page
      // under a history entry per dropdown change.
      setParams(p, { replace: true })
    },
    [scope, sites, params, setParams]
  )

  const clearScope = useMemo(
    () => () => {
      const p = new URLSearchParams(params)
      ;['site', 'entity', 'region'].forEach((k) => p.delete(k))
      setParams(p, { replace: true })
    },
    [params, setParams]
  )

  // Health over the WHOLE estate first, then narrowed — see scopeEstate for why
  // the order matters.
  const scoped = useMemo(
    () => scopeEstate(estate, scope, meta, { cameras, dvrs, merakis }),
    [estate, scope, meta, cameras, dvrs, merakis]
  )

  // Built from the UNSCOPED health pass, so a camera is tested against the site
  // it really resolves to rather than one that scoping already removed.
  const resolvedCameraSite = useMemo(
    () => new Map(estate.cameras.map((c) => [c.id, c.siteId])),
    [estate]
  )

  const value = useMemo(
    () => ({
      orgName,
      cameras,
      dvrs,
      merakis,
      sites,
      // `estate` stays the unscoped truth for anything that needs the whole
      // picture; `scoped` is what the pages render.
      estate: scoped,
      fullEstate: estate,
      error,
      denied,
      loading: !(loaded.cameras && loaded.dvrs && loaded.merakis),

      scope,
      setScope,
      clearScope,
      isScoped: isScoped(scope),
      facets: scopeFacets(sites),
      sitesInScope: narrowSites(sites, scope),
      // Raw rows narrowed the same way, for the inventory tables. A camera can
      // inherit its site from its DVR, so the resolved id is the one tested —
      // read from a map built once, not a find() per row.
      scopedRows: {
        cameras: filterByScope(
          cameras,
          scope,
          meta,
          (r) => resolvedCameraSite.get(r.id) || r.siteId
        ),
        dvrs: filterByScope(dvrs, scope, meta),
        merakis: filterByScope(merakis, scope, meta),
      },

      // Named lookups the forms need, built once rather than in every render.
      dvrOptions: dvrs.map((d) => ({
        value: d.id,
        label: d.name,
        siteId: d.siteId,
        siteName: d.siteName,
      })),
      siteOptions: sites.map((s) => ({ value: s.id, label: s.name || s.siteName || s.id })),
    }),
    [
      orgName,
      cameras,
      dvrs,
      merakis,
      sites,
      estate,
      scoped,
      scope,
      setScope,
      clearScope,
      meta,
      resolvedCameraSite,
      error,
      denied,
      loaded,
    ]
  )

  return <Ctx.Provider value={value}>{denied ? <AccessDenied /> : children}</Ctx.Provider>
}

export function useCctv() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCctv must be used inside CctvProvider')
  return ctx
}
