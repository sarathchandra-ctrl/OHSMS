// ─────────────────────────────────────────────────────────────────────────────
// Portal home.
//
// Two audiences share this screen. An operator wants the four task cards and
// their own open work; a manager wants to know whether their sites are actually
// compliant. Both get the same page, scoped to whatever sites the viewer may
// see — so the numbers are never larger than the viewer's permission.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts'
import ChartFrame from '../../shared/ui/ChartFrame'
import {
  AlertTriangle,
  ArrowRight,
  MapPin,
  Building2,
  ScrollText,
  UsersRound,
  Settings,
  BarChart3,
  Wrench,
  Network,
} from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import {
  subscribeCollections,
  emptyCollections,
  subscribeOrgUsersRead,
  readReady,
  collectionsAnswered,
} from '../../shared/org/orgData'
import { useAccessibleSitesRead } from '../../shared/org/useAccessibleSites'
import { regionsOf, entitiesOf, sitesInSelection, shortList } from '../../shared/auth/access'
import { subscribeActions, NORM_BY_KEY, SOURCES } from '../../modules/actions/lib/sources'
import { subscribeAssignmentsRead } from '../../modules/training/lib/data'
import { INCIDENT_TYPE_BY_KEY } from '../../modules/incidents/lib/constants'
import { enabledModules } from '../../shared/modules/entitlements'
import { Raised, Inset, SectionLabel } from './ui'
import { myActions } from './myWork'
import { portalStats, pendingWork } from './portalStats'
import WidgetGrid from './widgets/WidgetGrid'
import { useWidgetPrefs } from './widgets/useWidgetPrefs'
import { dashboardBuckets } from '../../modules/ptw/lib/permitStatus'
import { openUnsafeByPermit } from '../../modules/ptw/lib/observations'
import ModuleLogo3D, { has3DLogo } from './ModuleLogo3D'
import { desktopMarkClass } from './markMotion'
import { Button, Skeleton, Spinner } from '../../shared/ui'
import FieldAppGrid from '../../shared/layout/FieldAppGrid'
import { fieldIdle } from '../../shared/mobile/fieldIdle'
import { useViewMode, ViewModeSwitch } from '../../shared/mobile/viewModeContext'

// Admin tools. These configure the organization rather than record work in it,
// so the whole section is admin-only — a manager or auditor who can read the
// audit log still reaches it from the module they are working in, and does not
// need the org's plumbing on their home screen.
//
// Route guards are unchanged and remain the real control; hiding a tile is
// presentation, not permission.
const ADMIN_TOOLS = [
  {
    key: 'sites',
    label: 'Sites',
    title: 'Locations across your organization',
    path: '/sites',
    icon: Building2,
    tone: 'brand',
  },
  {
    key: 'users',
    label: 'Employees',
    title: 'Roles, access and bulk upload',
    path: '/users',
    icon: UsersRound,
    tone: 'green',
  },
  {
    key: 'settings',
    label: 'Org Settings',
    title: 'Organization profile and preferences',
    path: '/settings',
    icon: Settings,
    tone: 'amber',
  },
  {
    key: 'audit-log',
    label: 'Audit Log',
    title: 'Append-only record of every action',
    path: '/audit-log',
    icon: ScrollText,
    tone: 'violet',
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    title: 'One-off data repair jobs, each with a dry run',
    path: '/maintenance',
    icon: Wrench,
    tone: 'slate',
  },
]

/**
 * A module tile.
 *
 * The whole card is Liquid Glass. The logo sits in a fixed square at the
 * centre of that surface. Hover only scales that square from its own centre —
 * no translateZ and no tilt. A Z-lift used the tile as the vanishing point, so
 * the mark slid toward the middle of the card and off the row it shares with
 * its neighbours.
 *
 * The 3D artwork is drawn in absolute pixels and centred by the grid. Growing
 * the square alone only adds padding around that drawing. A scale on the same
 * in-flow grid enlarges it without a 0×0 left/top 50% anchor — that anchor
 * made every slab's top-left the centre, so the picture grew down and right.
 */
function Tile({ to, icon: Icon, tone = 'brand', label, title, delay = 0, logoKey }) {
  const has3D = has3DLogo(logoKey)
  const idle = fieldIdle(logoKey || label, Math.round(delay / 40))
  return (
    <Link
      to={to}
      data-tone={tone}
      style={{ animationDelay: `${delay}ms`, '--idle-delay': `${idle.phaseMs}ms` }}
      className={`group ${desktopMarkClass(has3D)} glass-tile relative flex min-h-[168px] animate-fade-in-up flex-col items-center justify-center gap-3 rounded-3xl p-5 text-center
                 transition-[transform,box-shadow] duration-200 ease-emil
                 hover:-translate-y-0.5 hover:shadow-elev-lg
                 active:translate-y-0 active:scale-[0.99]
                 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas
                 motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
    >
      <span aria-hidden="true" className="glass-tile-glow" data-tone={tone} />
      {/* Perspective lives on the mark, not the card, so any depth in a 3D
          logo expands around this square instead of drifting toward the tile. */}
      <span
        className="relative grid h-[76px] w-[76px] flex-none origin-center place-items-center [perspective:520px] [perspective-origin:center]
                   transition-transform duration-300 ease-emil
                   group-hover:scale-110
                   motion-reduce:transition-none motion-reduce:group-hover:transform-none"
      >
        <span
          className={`grid h-full w-full origin-center place-items-center [transform-style:preserve-3d] ${
            has3D ? '' : `field-idle field-idle-${idle.motion}`
          }`}
          style={
            has3D
              ? undefined
              : {
                  animationDelay: `${idle.delayMs}ms`,
                  animationDuration: `${idle.durationMs}ms`,
                }
          }
        >
          {has3D ? (
            <span className="grid h-full w-full origin-center place-items-center scale-[1.28] [transform-style:preserve-3d]">
              <ModuleLogo3D moduleKey={logoKey} />
            </span>
          ) : (
            <Icon size={36} strokeWidth={2} className="block" />
          )}
        </span>
      </span>

      <span className="min-w-0">
        <span className="block text-[15px] font-bold tracking-[-0.015em] text-ink-900">
          {label}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ink-500">{title}</span>
      </span>
    </Link>
  )
}

/**
 * Attach each permit's count of unanswered unsafe observations.
 *
 * The permits module does this in its own context, which the portal does not
 * mount — so it is repeated here rather than left out. Without it the portal
 * would count a permit with an unsafe report against it as merely open, while
 * the permits page shows it flagged.
 */
function withUnsafe(permits = [], observations = []) {
  const counts = openUnsafeByPermit(observations)
  return permits.map((p) => ({ ...p, openUnsafeCount: counts.get(p.id) || 0 }))
}

// Everything on this page that is a count comes from these. Status rides
// alongside the rows so a collection that has not loaded (or was refused)
// stays in loading rather than reading as a confident zero.
const COLLECTIONS = [
  'extinguishers',
  'aeds',
  'fas',
  'signages',
  'incidents',
  'consultations',
  'mockDrills',
  'permits',
  'observations',
]

// The action tracker fans out over these. Home waits until every one has
// answered (ok / capped / denied) before showing "nothing is waiting on you",
// because a missing source used to read as an empty inbox.
const ACTION_COLLECTIONS = [...new Set(SOURCES.map((s) => s.collection))]

const greeting = (d = new Date()) => {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function PortalHome() {
  const { profile, isAdmin, moduleMap } = useAuth()
  // The grid shows what this organization actually has. A tile leading to a
  // route that refuses to open is worse than no tile at all.
  const modules = useMemo(() => enabledModules(moduleMap), [moduleMap])
  const navigate = useNavigate()
  const { mode } = useViewMode()
  const { sites, status: sitesStatus } = useAccessibleSitesRead()
  const { keys: widgetKeys, save: saveWidgets } = useWidgetPrefs()

  // Region / Entity / Site, each 'all' or one value. Options come only from
  // the sites this person may see, so a pick can never widen their scope.
  const [scope, setScope] = useState({ region: 'all', entity: 'all', siteId: 'all' })
  const [store, setStore] = useState(() => emptyCollections(COLLECTIONS))
  const [assignments, setAssignments] = useState({ rows: [], status: 'pending' })
  const [users, setUsers] = useState({ rows: [], status: 'pending' })
  const [actions, setActions] = useState([])
  const [actionsStatus, setActionsStatus] = useState(() =>
    Object.fromEntries(ACTION_COLLECTIONS.map((n) => [n, 'pending']))
  )

  useEffect(() => {
    setStore(emptyCollections(COLLECTIONS))
    setAssignments({ rows: [], status: 'pending' })
    setUsers({ rows: [], status: 'pending' })
    setActions([])
    setActionsStatus(Object.fromEntries(ACTION_COLLECTIONS.map((n) => [n, 'pending'])))
    const unsubs = [
      subscribeCollections(COLLECTIONS, setStore),
      subscribeAssignmentsRead(setAssignments),
      subscribeOrgUsersRead(setUsers),
      subscribeActions(({ rows, status }) => {
        setActions(rows)
        setActionsStatus(status)
      }),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  const {
    extinguishers,
    aeds,
    fas,
    signages,
    incidents,
    consultations: meetings,
    mockDrills: drills,
    permits,
    observations,
  } = store.data
  const colStatus = store.status || {}

  const sitesReady = readReady(sitesStatus)
  const actionsReady = collectionsAnswered(actionsStatus, ACTION_COLLECTIONS)
  const assignmentsReady = readReady(assignments.status)
  const usersReady = readReady(users.status)
  const incidentsReady = readReady(colStatus.incidents)
  const equipmentReady = ['extinguishers', 'aeds', 'fas'].every((n) => readReady(colStatus[n]))
  const trainingReady = assignmentsReady && usersReady

  // A pick the viewer can no longer see (access removed, or an earlier pick
  // changed) would silently show zeros, so each falls back to All instead.
  // Each level's options are narrowed by the levels before it.
  const regionOptions = useMemo(() => regionsOf(sites), [sites])
  const region = regionOptions.includes(scope.region) ? scope.region : 'all'
  const entityOptions = useMemo(() => entitiesOf(sitesInSelection(sites, { region })), [sites, region])
  const entity = entityOptions.includes(scope.entity) ? scope.entity : 'all'
  const siteOptions = useMemo(() => sitesInSelection(sites, { region, entity }), [sites, region, entity])
  const pickedSite = siteOptions.some((s) => s.id === scope.siteId) ? scope.siteId : 'all'
  const scopedSites = useMemo(
    () => sitesInSelection(sites, { region, entity, siteId: pickedSite }),
    [sites, region, entity, pickedSite]
  )
  const narrowed = region !== 'all' || entity !== 'all' || pickedSite !== 'all'
  // 'all' only when nothing is picked: a narrowed view must leave out records
  // that carry no site (see scopeIds).
  const activeSite = useMemo(
    () => (narrowed ? scopedSites.map((s) => s.id) : 'all'),
    [narrowed, scopedSites]
  )

  const stats = useMemo(
    () =>
      portalStats({
        sites,
        siteId: activeSite,
        extinguishers,
        aeds,
        fas,
        signages,
        incidents,
        assignments: assignments.rows,
        users: users.rows,
        meetings,
        drills,
        permits,
      }),
    [
      sites,
      activeSite,
      extinguishers,
      aeds,
      fas,
      signages,
      incidents,
      assignments.rows,
      users.rows,
      meetings,
      drills,
      permits,
    ]
  )

  const mine = useMemo(() => myActions(actions, profile), [actions, profile])
  const open = mine.filter((a) => a.norm !== 'done')

  const pending = useMemo(
    () =>
      pendingWork({
        sites,
        siteId: activeSite,
        actions,
        assignments: assignments.rows,
        users: users.rows,
        limit: 5,
      }),
    [sites, activeSite, actions, assignments.rows, users.rows]
  )

  const pie = stats.incidentsByType.map((r) => ({
    name: INCIDENT_TYPE_BY_KEY[r.key]?.label || 'Unspecified',
    value: r.value,
    color: INCIDENT_TYPE_BY_KEY[r.key]?.color || '#8ba7bd',
  }))
  const bars = stats.equipmentBySite.slice(0, 8)

  const firstName = (profile?.name || '').split(' ')[0] || 'there'
  const scopeLabel = !sitesReady
    ? 'your sites'
    : pickedSite !== 'all'
      ? sites.find((s) => s.id === pickedSite)?.name
      : `${scopedSites.length} site${scopedSites.length === 1 ? '' : 's'}${
          narrowed ? ` in ${[entity, region].filter((v) => v !== 'all').join(', ')}` : ' you can see'
        }`

  // Everything a widget can ask for, already scoped. Widgets read from this
  // rather than from the raw collections, so none of them can reach around the
  // scoping that portalStats applied. A collection that has not loaded
  // successfully is null, which the widgets already render as "—".
  const widgetData = useMemo(
    () => ({
      stats: {
        ...stats,
        counts: {
          ...stats.counts,
          incidents: incidentsReady ? stats.counts.incidents : null,
          extinguishers: readReady(colStatus.extinguishers) ? stats.counts.extinguishers : null,
          aeds: readReady(colStatus.aeds) ? stats.counts.aeds : null,
          fas: readReady(colStatus.fas) ? stats.counts.fas : null,
        },
      },
      extinguishers: readReady(colStatus.extinguishers) ? stats.scoped.extinguishers : null,
      aeds: readReady(colStatus.aeds) ? stats.scoped.aeds : null,
      fas: readReady(colStatus.fas) ? stats.scoped.fas : null,
      meetings: readReady(colStatus.consultations) ? stats.counts.meetings : null,
      drills: readReady(colStatus.mockDrills) ? stats.counts.drills : null,
      // Joined the same way the permits module does it, or the portal would
      // count a permit with an unanswered unsafe report as merely open while
      // the permits page flags it — two screens disagreeing about the same permit.
      permits:
        readReady(colStatus.permits) && readReady(colStatus.observations)
          ? dashboardBuckets(withUnsafe(stats.scoped.permits, observations))
          : null,
      myOpenActions: actionsReady ? open.length : null,
      myPendingTraining: trainingReady ? pending.training.length : null,
    }),
    [stats, colStatus, observations, incidentsReady, actionsReady, trainingReady, open, pending]
  )

  return (
    <div className="animate-fade-in-up">
      {/* The grid and the dashboard are two homes, chosen by view mode. A
          phone that asked for the desktop portal gets this dashboard and
          scrolls it; a desktop that asked for the phone home gets the grid,
          centred. */}
      {mode === 'mobile' ? (
        <div className="mx-auto max-w-md">
          <FieldAppGrid />
        </div>
      ) : (
      <div>
      <ViewModeSwitch />
      <div className="mb-5 grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <Raised className="relative overflow-hidden px-6 py-6 sm:px-7">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(60% 90% at 96% 12%, rgba(221,90,65,.14), transparent 65%),' +
                'radial-gradient(50% 80% at 88% 96%, rgba(127,196,187,.16), transparent 60%)',
            }}
          />
          <p className="relative text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
          <h1 className="relative mt-2 break-words text-[28px] font-extrabold leading-[1.15] tracking-[-0.025em] text-ink-900 sm:text-[30px]">
            {greeting()}, {firstName}.
          </h1>
          {actionsReady ? (
            <p className="relative mt-2 max-w-[46ch] text-sm leading-relaxed text-ink-500">
              {open.length
                ? `${open.length} action${open.length === 1 ? '' : 's'} assigned to you. Everything below is scoped to ${scopeLabel}.`
                : `Nothing is waiting on you. Everything below is scoped to ${scopeLabel}.`}
            </p>
          ) : (
            <div className="relative mt-2 max-w-[46ch]">
              <Skeleton className="h-4 w-72 max-w-full" />
            </div>
          )}
          <div className="relative mt-5 flex flex-wrap gap-2.5">
            {/* With no navigation bar, this is the only way to the report
                wizard — and reporting is the thing most people open the portal
                to do, so it leads. */}
            <Button type="button" onClick={() => navigate('/portal/report')} icon={AlertTriangle}>
              Report an incident
            </Button>
            <Button type="button" variant="soft" onClick={() => navigate('/portal/actions')}>
              {actionsReady && open.length
                ? `My ${open.length} open action${open.length === 1 ? '' : 's'}`
                : 'My actions'}
              <ArrowRight size={14} strokeWidth={2.4} />
            </Button>
            <Button type="button" variant="ghost" onClick={() => navigate('/portal/training')}>
              My training
            </Button>
          </div>
        </Raised>

        <Raised className="flex flex-col gap-3 p-5">
          <SectionLabel className="tracking-[0.14em]">Viewing</SectionLabel>
          <ScopeSelect
            id="region-scope"
            label="Region"
            icon={MapPin}
            value={region}
            allLabel={`All regions${sitesReady ? ` (${regionOptions.length})` : ''}`}
            options={regionOptions.map((r) => ({ value: r, label: r }))}
            onChange={(v) => setScope({ region: v, entity: 'all', siteId: 'all' })}
          />
          <ScopeSelect
            id="entity-scope"
            label="Entity"
            icon={Network}
            value={entity}
            allLabel={`All entities${sitesReady ? ` (${entityOptions.length})` : ''}`}
            options={entityOptions.map((e) => ({ value: e, label: e }))}
            onChange={(v) => setScope({ region, entity: v, siteId: 'all' })}
          />
          <ScopeSelect
            id="site-scope"
            label="Site"
            icon={Building2}
            value={pickedSite}
            allLabel={`All sites${sitesReady ? ` (${siteOptions.length})` : ''}`}
            options={siteOptions.map((s) => ({ value: s.id, label: s.name }))}
            onChange={(v) => setScope({ region, entity, siteId: v })}
          />
          {!sitesReady ? (
            <div>
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
          ) : (
            <>
            {scopedSites.length > 0 && (
              <dl className="space-y-1 rounded-xl bg-surface-50 px-3 py-2.5 text-[12px] ring-1 ring-ink-900/5">
                {[
                  ['Regions', regionsOf(scopedSites)],
                  ['Entities', entitiesOf(scopedSites)],
                  ['Sites', scopedSites.map((s) => s.name).sort((a, b) => a.localeCompare(b))],
                ].map(([label, names]) => (
                  <div key={label} className="flex gap-1.5" title={names.join(', ')}>
                    <dt className="flex-none font-semibold text-ink-500">{label}:</dt>
                    <dd className="min-w-0 text-ink-800">{names.length ? shortList(names, 4) : '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="text-[11.5px] leading-relaxed text-ink-400">
              {sites.length === 0
                ? 'No sites are mapped to you yet, so these figures cover nothing. Ask an admin to map your site.'
                : 'Only the regions, entities and sites your account can see are listed. Every figure on this page follows this selection.'}
            </p>
            </>
          )}
          {actionsReady && open.length > 0 && (
            <div className="mt-auto flex flex-col gap-2 border-t border-ink-100 pt-3">
              {open.slice(0, 2).map((a) => (
                <Link
                  key={a.key}
                  to="/portal/actions"
                  className="flex items-center gap-2.5 rounded-xl bg-surface-50 px-3 py-2 ring-1 ring-ink-900/5 transition-colors hover:bg-surface-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  <span
                    className="h-6 w-1 flex-none rounded"
                    style={{ background: NORM_BY_KEY[a.norm]?.color || '#ab987f' }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-900">
                    {a.title}
                  </span>
                  {a.overdue && (
                    <span className="flex-none rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
                      Overdue
                    </span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </Raised>
      </div>

      {/* The home page used to put IncompleteNotice here — amber "could not be
          loaded" copy for a capped or failed listener. The owner asked that
          this screen stay in loading instead, so a missing collection is a
          spinner, not a warning, and a denied one is quiet. */}
      <WidgetGrid
        keys={widgetKeys}
        onSave={saveWidgets}
        data={widgetData}
        sites={sitesReady ? scopedSites : null}
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Raised className="p-5">
          <p className="text-[15px] font-bold tracking-[-0.015em] text-ink-900">
            Incidents by type
          </p>
          <p className="mb-2 text-[11.5px] text-ink-400">{scopeLabel}</p>
          {incidentsReady && pie.length === 0 ? (
            <EmptyChart>
              No incidents recorded for this scope — which is the result you want.
            </EmptyChart>
          ) : incidentsReady ? (
            <ChartFrame label="Incidents by type" width="100%" height={240}>
              <PieChart>
                <Pie
                  data={pie}
                  dataKey="value"
                  nameKey="name"
                  outerRadius={82}
                  innerRadius={46}
                  paddingAngle={2}
                >
                  {pie.map((d) => (
                    <Cell key={d.name} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ChartFrame>
          ) : (
            <PanelBusy />
          )}
        </Raised>

        <Raised className="p-5">
          <p className="text-[15px] font-bold tracking-[-0.015em] text-ink-900">
            Equipment by site
          </p>
          <p className="mb-2 text-[11.5px] text-ink-400">
            {equipmentReady && bars.length
              ? `Busiest ${bars.length} of ${stats.equipmentBySite.length}`
              : scopeLabel}
          </p>
          {equipmentReady && bars.length === 0 ? (
            <EmptyChart>No equipment is linked to these sites yet.</EmptyChart>
          ) : equipmentReady ? (
            <ChartFrame label="Equipment by site" width="100%" height={240}>
              <BarChart data={bars} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  tick={{ fill: '#8a6844' }}
                  interval={0}
                  tickFormatter={(v) => String(v).slice(0, 10)}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  tick={{ fill: '#8a6844' }}
                />
                <Tooltip cursor={{ fill: 'rgba(34,211,238,0.08)' }} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: '#8a6844' }} />
                <Bar
                  dataKey="extinguishers"
                  name="Extinguishers"
                  fill="#6db3aa"
                  radius={[6, 6, 0, 0]}
                />
                <Bar dataKey="aeds" name="AED" fill="#8fbc74" radius={[6, 6, 0, 0]} />
                <Bar dataKey="fas" name="Fire alarm" fill="#fb923c" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ChartFrame>
          ) : (
            <PanelBusy />
          )}
        </Raised>
      </div>

      <SectionLabel className="mb-3">Closest to due</SectionLabel>
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Raised className="p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <p className="text-[15px] font-bold tracking-[-0.015em] text-ink-900">
              Pending actions
            </p>
            <Link
              to="/portal/actions"
              className="rounded text-xs font-semibold text-brand-700 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              My actions
            </Link>
          </div>
          <DueList
            rows={pending.actions}
            empty="No open actions across these sites."
            meta={(r) => r.source}
            loading={!actionsReady}
          />
        </Raised>

        <Raised className="p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <p className="text-[15px] font-bold tracking-[-0.015em] text-ink-900">
              Pending training
            </p>
            <Link
              to="/portal/training"
              className="rounded text-xs font-semibold text-brand-700 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              My training
            </Link>
          </div>
          <DueList
            rows={pending.training}
            empty="Nothing outstanding for people at these sites."
            loading={!trainingReady}
          />
        </Raised>
      </div>

      <SectionLabel className="mb-3">All modules</SectionLabel>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {/* Analytics sits in the grid rather than above it — it is one more
            destination, and a full-width banner claimed an importance the
            others have equal claim to. */}
        <Tile
          to="/analytics"
          icon={BarChart3}
          tone="blue"
          label="Analytics"
          title="Trends and breakdowns across your sites"
          logoKey="analytics"
        />
        {modules.map((m, i) => (
          <Tile
            key={m.key}
            to={m.path}
            icon={m.icon}
            tone={m.tone}
            label={m.label}
            title={m.title}
            logoKey={m.key}
            delay={Math.min(i, 8) * 40}
          />
        ))}
      </div>

      {isAdmin && (
        <>
          <SectionLabel className="mb-3 mt-8">Admin tools</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {ADMIN_TOOLS.map((s, i) => (
              <Tile
                key={s.key}
                to={s.path}
                icon={s.icon}
                tone={s.tone}
                label={s.label}
                title={s.title}
                delay={600 + i * 80}
              />
            ))}
          </div>
        </>
      )}
      </div>
      )}
    </div>
  )
}

/**
 * A due-date list: what it is, who owns it, when it is due.
 *
 * The owner is shown on every row rather than only where it differs, because
 * the question this list answers is "whose is it" as much as "what is it".
 */
function DueList({ rows, empty, meta, loading }) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2.5" role="status" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
    )
  }
  if (!rows.length) {
    return (
      <p className="rounded-xl bg-surface-50 px-4 py-6 text-center text-[13px] text-ink-400 ring-1 ring-ink-900/5">
        {empty}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li
          key={r.key}
          className="flex items-center gap-3.5 rounded-2xl bg-surface-50 px-4 py-3 ring-1 ring-ink-200"
        >
          <span
            className="h-[34px] w-1 flex-none rounded"
            style={{ background: r.overdue ? '#e8877c' : r.due ? '#e8a33d' : '#6db3aa' }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold text-ink-900">{r.title}</p>
            <p className="mt-0.5 truncate text-[11.5px] text-ink-400">
              {r.owner}
              {meta && meta(r) ? ` · ${meta(r)}` : ''}
            </p>
          </div>
          <span
            className={`flex-none rounded-full px-2.5 py-1 text-[10.5px] font-bold ${
              r.overdue ? 'bg-red-100 text-red-700' : 'bg-surface-100 text-ink-600'
            }`}
          >
            {r.overdue ? 'Overdue' : r.due || 'No date'}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** One level of the portal's Region / Entity / Site scope. */
function ScopeSelect({ id, label, icon: Icon, value, allLabel, options, onChange }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-ink-500" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Icon
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400"
        />
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input w-full appearance-none py-2.5 pl-10 text-[13.5px] font-semibold"
        >
          <option value="all">{allLabel}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function PanelBusy() {
  return (
    <Inset
      className="grid h-[240px] place-items-center"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <Spinner />
    </Inset>
  )
}

function EmptyChart({ children }) {
  return (
    <Inset className="grid h-[240px] place-items-center px-6 text-center">
      <p className="max-w-[32ch] text-[13px] leading-relaxed text-ink-400">{children}</p>
    </Inset>
  )
}
