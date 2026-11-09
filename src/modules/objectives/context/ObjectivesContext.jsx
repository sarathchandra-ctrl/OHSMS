import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { subscribeOrgCollection, incompleteReadNotice } from '../../../shared/org/orgData'
import { useAccessibleSites, useSiteFacets } from '../../../shared/org/useAccessibleSites'
import { subscribeActions } from '../../actions/lib/sources'
import { subscribeObjectives } from '../lib/firestore'

const ObjectivesContext = createContext(null)

// Raw collections the KPI engine measures. All shared app-wide, so opening the
// scorecard costs no extra reads when these modules are already mounted.
const SOURCES = {
  auditReports: 'auditFindings',
  extinguishers: 'extinguishers',
  fas: 'fas',
  signages: 'signages',
  incidents: 'incidents',
}
const EMPTY = Object.fromEntries(Object.keys(SOURCES).map((k) => [k, []]))

/** Targets plus live module records, so KPI actuals are never snapshotted. */
export function ObjectivesProvider({ children }) {
  const [objectives, setObjectives] = useState(null)
  const [raw, setRaw] = useState(EMPTY)
  const [rawActions, setRawActions] = useState([])
  // Per-collection read status, so the scorecard can say when a percentage is
  // built on a short read. subscribeOrgCollection has always emitted this and
  // this provider threw it away — destructuring `{ rows }` and dropping
  // `status` — which made the KPI page the one screen in the app that reports a
  // capped count as a real one. That is the worst place for it: an OH&S
  // objective is measured here and then quoted upward, and "62% of extinguishers
  // inspected" carries no hint that the denominator stopped at 5 000.
  const [readStatus, setReadStatus] = useState({})
  const sites = useAccessibleSites()
  const { regions, entities } = useSiteFacets(sites)

  useEffect(() => {
    const unsubs = [
      subscribeObjectives(setObjectives),
      subscribeActions(({ rows, incomplete }) => {
        setRawActions(rows)
        // The Action Tracker resolves its own sources, so it hands back a ready
        // notice rather than a per-collection status. Fold it in under one key.
        setReadStatus((s) => ({ ...s, actions: incomplete ? 'capped' : 'ok' }))
      }),
      ...Object.entries(SOURCES).map(([key, name]) =>
        subscribeOrgCollection(name, ({ rows, status }) => {
          setRaw((r) => ({ ...r, [key]: rows }))
          setReadStatus((s) => ({ ...s, [name]: status }))
        }),
      ),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  const value = useMemo(() => ({
    loading: objectives === null,
    objectives: objectives || [],
    // Action Tracker rows use `norm`; the KPI engine reads `status`.
    data: { ...raw, actions: rawActions.map((a) => ({ ...a, status: a.norm })) },
    // Handed out beside the data, never separately: a caller holding the rows
    // is holding the reason they may be short. Null while everything is whole.
    incomplete: incompleteReadNotice(readStatus),
    sites,
    regions,
    entities,
    regionScopes: regions.map((r) => ({ value: r, label: r })),
    siteScopes: sites.map((s) => ({ value: s.id, label: s.name, region: s.region, entity: s.entity })),
  }), [objectives, raw, rawActions, readStatus, sites, regions, entities])

  return <ObjectivesContext.Provider value={value}>{children}</ObjectivesContext.Provider>
}

export function useObjectives() {
  const ctx = useContext(ObjectivesContext)
  if (!ctx) throw new Error('useObjectives must be used within ObjectivesProvider')
  return ctx
}
