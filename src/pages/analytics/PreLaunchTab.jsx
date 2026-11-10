// ─────────────────────────────────────────────────────────────────────────────
// Pre-launch readiness.
//
// Every other tab counts events that happened. This one counts paperwork that
// has NOT — the handover schedule each site owes before it opens, and how much
// of it exists. The number people want is a single percentage per site, and the
// number that matters underneath it is which rows are still empty.
//
// ── Why this tab owns its query ──────────────────────────────────────────────
//
// The page reads its other collections through subscribeCollections, which asks
// for the whole collection. Documents are read through the library's own
// service instead, which plans its queries to match the site rule
// exactly — the same call the Documents module makes, so the tab and the folder
// can never disagree about what a site has filed.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable react-refresh/only-export-components --
   `sitePanelRows` is exported for the test alongside this component, not for
   other components to import. */
import { useEffect, useMemo, useState } from 'react'
import { Rocket, CheckCircle2, FileWarning, CircleDashed } from 'lucide-react'
import { Panel, Stat, NoData, Picker, FilterRow } from './ui'
import Breakdown from './Breakdown'
import IncompleteNotice from '../../shared/ui/IncompleteNotice'
import { useAuth } from '../../shared/auth/AuthContext'
import { documentsService } from '../../modules/documents/lib/service'
import { PRE_LAUNCH_TOTAL } from '../../modules/documents/lib/prelaunch'
import { prelaunchAnalytics, prelaunchFacets, readyColor } from './prelaunchAnalytics'

/** How many site rows the worklist shows before it says it stopped. */
export const SITE_ROWS = 12

/**
 * The site rows to render, and how many were left out.
 *
 * Truncation is stated rather than silent: a list that quietly stops at twelve
 * reads as "these are the sites", which is the one thing a readiness worklist
 * must never imply.
 */
export function sitePanelRows(rows = [], limit = SITE_ROWS) {
  return { shown: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) }
}

function Meter({ pct }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-100">
      <span
        className="block h-full rounded-full"
        style={{ width: `${pct}%`, background: readyColor(pct) }}
      />
    </span>
  )
}

/** A row of the worklist: a name, how far it has got, and the bar. */
function ProgressRow({ name, sub, ready, total, pct }) {
  return (
    <li className="rounded-[14px] bg-surface-50 px-3.5 py-2.5 shadow-elev-sm">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink-900">{name}</span>
          {sub && <span className="block truncate text-[11px] text-ink-400">{sub}</span>}
        </span>
        <span className="flex-none text-[12px] font-bold text-ink-700">{pct}%</span>
        <span className="w-16 flex-none text-right text-[11px] font-semibold text-ink-400">
          {ready}/{total}
        </span>
      </div>
      <Meter pct={pct} />
    </li>
  )
}

export default function PreLaunchTab({ sites = [] }) {
  const { role } = useAuth()
  const [docs, setDocs] = useState(null) // null = still loading
  // A capped or failed read makes every figure on this tab too LOW, and too low
  // here reads as "this site is behind" — a number somebody acts on. It is said
  // above the figures, never below them.
  const [incomplete, setIncomplete] = useState(null)
  const [f, setF] = useState({ siteId: 'all', region: 'all', entity: 'all' })

  const viewer = useMemo(() => ({ role, sites }), [role, sites])

  useEffect(() => {
    setDocs(null)
    return documentsService.subscribe(
      (rows, notice) => { setDocs(rows); setIncomplete(notice) },
      viewer
    )
  }, [viewer])

  const opts = useMemo(() => prelaunchFacets(sites), [sites])
  const a = useMemo(() => prelaunchAnalytics(docs || [], sites, f), [docs, sites, f])
  const { shown, hidden } = useMemo(() => sitePanelRows(a.rows), [a.rows])

  // A site filtered down to nothing is a different answer from a site with
  // nothing filed, and the percentage cannot tell them apart.
  const empty = a.sites === 0

  return (
    <div className="animate-fade-in-up">
      <IncompleteNotice incomplete={incomplete} className="mb-5" />

      <div className="card mb-5 divide-y divide-ink-100">
        <FilterRow label="Where">
          <Picker id="pl-site" label="Site" value={f.siteId} onChange={(e) => setF((v) => ({ ...v, siteId: e.target.value }))}>
            <option value="all">Every site</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
          </Picker>
          <Picker id="pl-region" label="Region" value={f.region} onChange={(e) => setF((v) => ({ ...v, region: e.target.value }))}>
            <option value="all">Every region</option>
            {opts.regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </Picker>
          <Picker id="pl-entity" label="Entity" value={f.entity} onChange={(e) => setF((v) => ({ ...v, entity: e.target.value }))}>
            <option value="all">Every entity</option>
            {opts.entities.map((r) => <option key={r} value={r}>{r}</option>)}
          </Picker>
        </FilterRow>
      </div>

      {docs === null ? (
        <NoData>Reading the document library…</NoData>
      ) : empty ? (
        <NoData>No site matches this filter, so there is no handover pack to measure.</NoData>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              icon={Rocket}
              label="Handover documents ready"
              value={`${a.pct}%`}
              tone="#6db3aa"
              sub={`${a.ready} of ${a.required} across ${a.sites} site${a.sites === 1 ? '' : 's'}`}
            />
            <Stat
              icon={CheckCircle2}
              label="Sites with a complete pack"
              value={a.complete}
              tone="#22c55e"
              sub={`all ${PRE_LAUNCH_TOTAL} documents attached`}
            />
            <Stat
              icon={CircleDashed}
              label="Documents not filed"
              value={a.missing}
              tone="#8ba7bd"
              sub={a.untouched ? `${a.untouched} site${a.untouched === 1 ? ' has' : 's have'} not started` : 'every site has started'}
            />
            {/* Its own tile, because it is the failure nobody chases: a row with
                a record against it reads as done on any count of records, and
                produces nothing on the day. */}
            <Stat
              icon={FileWarning}
              label="Logged with no file"
              value={a.stub}
              tone="#f59e0b"
              sub="counted as missing above"
            />
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-2">
            <Panel
              title="Sites still to finish"
              subtitle="Least ready first — the ones worth a call"
            >
              {shown.length === 0 ? <NoData height={160}>No sites in this scope.</NoData> : (
                <>
                  <ul className="flex flex-col gap-2">
                    {shown.map((r) => (
                      <ProgressRow
                        key={r.key}
                        name={r.name}
                        sub={`${r.region} · ${r.entity}`}
                        ready={r.ready}
                        total={r.total}
                        pct={r.pct}
                      />
                    ))}
                  </ul>
                  {hidden > 0 && (
                    <p className="mt-2.5 text-[11.5px] text-ink-400">
                      {hidden} more site{hidden === 1 ? '' : 's'} not shown — filter to a region or
                      entity to see them.
                    </p>
                  )}
                </>
              )}
            </Panel>

            <Panel
              title="By category"
              subtitle="Which part of the schedule the estate is furthest behind on"
            >
              <ul className="flex flex-col gap-2">
                {a.byCategory.map((c) => (
                  <ProgressRow
                    key={c.key}
                    name={`${c.numeral}. ${c.name}`}
                    ready={c.ready}
                    total={c.total}
                    pct={c.pct}
                  />
                ))}
              </ul>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown
              title="Readiness by region"
              subtitle="% of the handover documents attached"
              rows={a.byRegion}
            />
            <Breakdown
              title="Readiness by entity"
              subtitle="% of the handover documents attached"
              rows={a.byEntity}
            />
          </div>
        </>
      )}
    </div>
  )
}
