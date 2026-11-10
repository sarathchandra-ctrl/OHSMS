import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  Building2,
  Search,
  PhoneCall,
  Phone,
  Map,
  LifeBuoy,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Wand2,
  MapPin,
} from 'lucide-react'
import {
  PageHeader,
  Card,
  Select,
  StatCard,
  EmptyState,
  SkeletonTable,
  Badge,
  Pager,
  Button,
  Modal,
} from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { subscribeContacts, subscribeLayouts, subscribeRescuePlans } from '../lib/data'
import {
  refreshSites,
  needsRealNumber,
  siteNeedsRefresh,
  siteNeedsRecompute,
} from '../lib/autofill'
import { activeProvider } from '../lib/nearby'

const PAGE_SIZE = 25

/** Compact ok/missing cell. */
function Cell({ ok, children }) {
  return <span className={ok ? 'font-semibold text-ink-800' : 'text-ink-300'}>{children}</span>
}

export default function SiteRepository() {
  const { actor, isManager } = useAuth()
  const navigate = useNavigate()
  const [refreshOpen, setRefreshOpen] = useState(false)
  const [refreshScope, setRefreshScope] = useState('recompute') // 'recompute' | 'needed' | 'all'
  const [replaceManual, setReplaceManual] = useState(false)
  const [run, setRun] = useState(null) // { done, total, current, log[], summary }
  const cancelRef = useRef(false)
  const [contacts, setContacts] = useState(null)
  const [layouts, setLayouts] = useState({})
  const [plans, setPlans] = useState([])
  const [f, setF] = useState({ q: '', region: 'all', entity: 'all', site: 'all', status: 'all' })
  const [page, setPage] = useState(1)

  useEffect(() => {
    const u1 = subscribeContacts(setContacts)
    const u2 = subscribeLayouts(setLayouts)
    const u3 = subscribeRescuePlans(setPlans)
    return () => {
      u1()
      u2()
      u3()
    }
  }, [])

  useEffect(() => {
    setPage(1)
  }, [f])

  const siteInventory = useAccessibleSites()

  const rows = useMemo(() => {
    const list = contacts || []
    return siteInventory.map((s) => {
      const mine = list.filter((c) => !c.siteId || c.siteId === s.id)
      const internal = mine.filter((c) => c.kind === 'internal').length
      const external = mine.filter((c) => c.kind === 'external').length
      const sitePlans = plans.filter((p) => p.siteId === s.id && p.status === 'approved').length
      const hasLayout = !!layouts[s.id]
      // External contacts still carrying no number, or a generic helpline left
      // behind by the old auto-fill — these look verified but are not.
      const unverified = mine.filter((c) => c.kind === 'external' && needsRealNumber(c)).length
      return {
        site: s,
        internal,
        external,
        hasLayout,
        plans: sitePlans,
        unverified,
        hasCoords: s.lat != null && s.lng != null,
        ready: internal > 0 && external > 0 && hasLayout && sitePlans > 0,
      }
    })
  }, [siteInventory, contacts, layouts, plans])

  // Correlated filter options: entity narrows to the chosen region, site to both.
  const regions = useMemo(
    () => [...new Set(siteInventory.map((s) => s.region).filter(Boolean))].sort(),
    [siteInventory]
  )
  const entities = useMemo(
    () =>
      [
        ...new Set(
          siteInventory
            .filter((s) => f.region === 'all' || s.region === f.region)
            .map((s) => s.entity)
            .filter(Boolean)
        ),
      ].sort(),
    [siteInventory, f.region]
  )
  const siteOptions = useMemo(
    () =>
      siteInventory
        .filter(
          (s) =>
            (f.region === 'all' || s.region === f.region) &&
            (f.entity === 'all' || s.entity === f.entity)
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [siteInventory, f.region, f.entity]
  )

  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase()
    return rows
      .filter((r) => (f.region === 'all' ? true : r.site.region === f.region))
      .filter((r) => (f.entity === 'all' ? true : r.site.entity === f.entity))
      .filter((r) => (f.site === 'all' ? true : r.site.id === f.site))
      .filter((r) => (f.status === 'all' ? true : f.status === 'ready' ? r.ready : !r.ready))
      .filter((r) =>
        q
          ? `${r.site.name} ${r.site.region || ''} ${r.site.entity || ''}`.toLowerCase().includes(q)
          : true
      )
      .sort((a, b) => Number(a.ready) - Number(b.ready) || a.site.name.localeCompare(b.site.name))
  }, [rows, f])

  const totals = useMemo(
    () => ({
      sites: shown.length,
      ready: shown.filter((r) => r.ready).length,
      gaps: shown.filter((r) => !r.ready).length,
      plans: shown.reduce((n, r) => n + r.plans, 0),
    }),
    [shown]
  )

  // ── Refresh nearest services from coordinates ──────────────────────────────
  // Only sites that actually have coordinates can be looked up.
  const withCoords = useMemo(
    () => siteInventory.filter((s) => s.lat != null && s.lng != null),
    [siteInventory]
  )
  const contactsReady = Array.isArray(contacts)
  const needingRefresh = useMemo(
    () => (contactsReady ? withCoords.filter((s) => siteNeedsRefresh(s, contacts)) : []),
    [withCoords, contacts, contactsReady]
  )
  const recomputeTargets = useMemo(
    () => (contactsReady ? withCoords.filter((s) => siteNeedsRecompute(s, contacts)) : []),
    [withCoords, contacts, contactsReady]
  )
  const refreshTargets =
    refreshScope === 'all'
      ? withCoords
      : refreshScope === 'needed'
        ? needingRefresh
        : recomputeTargets
  const noCoords = siteInventory.length - withCoords.length
  const unverifiedTotal = useMemo(() => rows.reduce((n, r) => n + r.unverified, 0), [rows])

  const startRefresh = async () => {
    cancelRef.current = false
    const targets = refreshTargets
    setRun({
      done: 0,
      total: targets.length,
      current: targets[0]?.name || '',
      log: [],
      summary: null,
    })
    const log = []
    const summary = await refreshSites(
      targets,
      contacts || [],
      actor,
      ({ done, total, site, status, detail }) => {
        if (status !== 'running') log.push({ site: site.name, status, detail })
        setRun({ done, total, current: site.name, log: [...log].slice(-200), summary: null })
      },
      { shouldStop: () => cancelRef.current, replaceManual }
    )
    setRun((p) => ({
      ...(p || {}),
      done: targets.length,
      total: targets.length,
      current: '',
      log,
      summary,
    }))
    toast[summary.failed ? 'error' : 'success'](
      `${summary.ok} site(s) refreshed` + (summary.failed ? ` · ${summary.failed} failed` : '')
    )
  }

  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <>
      <PageHeader
        title="Site Emergency Repository"
        subtitle="Each site's emergency contacts, FERP plan and scenario rescue plans — in one place"
        icon={Building2}
        actions={
          isManager &&
          withCoords.length > 0 && (
            <Button
              icon={Wand2}
              variant="ghost"
              disabled={!contactsReady}
              title={
                contactsReady
                  ? 'Recompute nearest hospital, police and fire station'
                  : 'Contacts are still loading'
              }
              onClick={() => {
                setRun(null)
                setReplaceManual(false)
                setRefreshOpen(true)
              }}
            >
              Refresh nearest services
            </Button>
          )
        }
      />

      {/* Contacts that look verified but are not. Worth saying loudly: in an
          emergency somebody will dial whatever is printed on the poster. */}
      {isManager && unverifiedTotal > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50">
          <div className="flex flex-wrap items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-amber-900">
                {unverifiedTotal} external contact{unverifiedTotal === 1 ? '' : 's'} without a
                verified direct number
              </p>
              <p className="mt-0.5 text-sm text-amber-800">
                These carry no number, or a national helpline (112/100/101/102/108) stored as if it
                were the station&apos;s own line. Refresh pulls each service&apos;s published number
                from the site&apos;s coordinates; anything OpenStreetMap has no number for is left
                blank for you to confirm locally.
              </p>
            </div>
            <Button
              icon={Wand2}
              className="!py-2"
              onClick={() => {
                setRun(null)
                setRefreshOpen(true)
              }}
            >
              Refresh now
            </Button>
          </div>
        </Card>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Sites" value={totals.sites} icon={Building2} tone="brand" />
        <StatCard label="Emergency ready" value={totals.ready} icon={CheckCircle2} tone="green" />
        <StatCard label="With gaps" value={totals.gaps} icon={AlertTriangle} tone="red" />
        <StatCard label="Rescue plans" value={totals.plans} icon={LifeBuoy} tone="amber" />
      </div>

      {/* Filters */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
            />
            <input
              className="input pl-9"
              placeholder="Search site…"
              value={f.q}
              onChange={(e) => setF((p) => ({ ...p, q: e.target.value }))}
            />
          </div>
          <Select
            className="!w-auto"
            value={f.region}
            onChange={(e) =>
              setF((p) => ({ ...p, region: e.target.value, entity: 'all', site: 'all' }))
            }
          >
            <option value="all">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Select
            className="!w-auto"
            value={f.entity}
            onChange={(e) => setF((p) => ({ ...p, entity: e.target.value, site: 'all' }))}
          >
            <option value="all">All entities</option>
            {entities.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            className="!w-auto"
            value={f.site}
            onChange={(e) => setF((p) => ({ ...p, site: e.target.value }))}
          >
            <option value="all">All sites</option>
            {siteOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Select
            className="!w-auto"
            value={f.status}
            onChange={(e) => setF((p) => ({ ...p, status: e.target.value }))}
          >
            <option value="all">Any readiness</option>
            <option value="ready">Emergency ready</option>
            <option value="gaps">With gaps</option>
          </Select>
        </div>
      </Card>

      {contacts === null ? (
        <SkeletonTable rows={6} cols={7} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={rows.length ? 'No matching sites' : 'No sites yet'}
          description={
            rows.length
              ? 'Try different filters.'
              : 'Add sites first — each one gets its own emergency repository.'
          }
        />
      ) : (
        <Card className="overflow-hidden !p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-5 py-3">Site</th>
                  <th className="px-4 py-3">Region</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3 text-center">External</th>
                  <th className="px-4 py-3 text-center">Internal</th>
                  <th className="px-4 py-3 text-center">FERP plan</th>
                  <th className="px-4 py-3 text-center">Rescue plans</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((r) => (
                  <tr
                    key={r.site.id}
                    className="cursor-pointer hover:bg-surface-100/50"
                    onClick={() => navigate(`/emergency-response/sites/${r.site.id}`)}
                    title="Open site repository"
                  >
                    <td className="px-5 py-3 font-semibold text-ink-900">{r.site.name}</td>
                    <td className="px-4 py-3 text-ink-600">{r.site.region || '—'}</td>
                    <td className="px-4 py-3 text-ink-600">{r.site.entity || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <Cell ok={r.external > 0}>
                        <PhoneCall size={12} className="mr-1 inline" />
                        {r.external}
                      </Cell>
                      {r.unverified > 0 && (
                        <span
                          className="ml-1 inline-flex items-center text-amber-600"
                          title={`${r.unverified} contact(s) have no verified direct number`}
                        >
                          <AlertTriangle size={12} />
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell ok={r.internal > 0}>
                        <Phone size={12} className="mr-1 inline" />
                        {r.internal}
                      </Cell>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {r.hasLayout ? (
                        <Map size={15} className="mx-auto text-green-600" />
                      ) : (
                        <span className="text-ink-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Cell ok={r.plans > 0}>
                        <LifeBuoy size={12} className="mr-1 inline" />
                        {r.plans}
                      </Cell>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={r.ready ? 'green' : 'amber'}>{r.ready ? 'Ready' : 'Gaps'}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ArrowRight size={15} className="inline text-ink-300" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-surface-200/60 px-4 py-3"
            page={safePage}
            pageCount={pageCount}
            onPage={setPage}
            total={shown.length}
            pageSize={PAGE_SIZE}
          />
        </Card>
      )}

      {/* ── Refresh nearest services from site coordinates ── */}
      <Modal
        open={refreshOpen}
        onClose={() => {
          if (!run || run.summary) {
            setRefreshOpen(false)
            setRun(null)
          }
        }}
        title="Refresh nearest emergency services"
        size="lg"
        footer={
          run && !run.summary ? (
            <Button
              variant="ghost"
              onClick={() => {
                cancelRef.current = true
              }}
            >
              Stop after this site
            </Button>
          ) : run?.summary ? (
            <Button
              onClick={() => {
                setRefreshOpen(false)
                setRun(null)
              }}
            >
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setRefreshOpen(false)}>
                Cancel
              </Button>
              <Button icon={Wand2} disabled={refreshTargets.length === 0} onClick={startRefresh}>
                Refresh {refreshTargets.length} site{refreshTargets.length === 1 ? '' : 's'}
              </Button>
            </>
          )
        }
      >
        {!run ? (
          <div className="space-y-4">
            <p className="text-sm text-ink-600">
              Looks up the nearest Hospital, Police station and Fire station from each site&apos;s
              latitude and longitude, and stores the name, address, straight-line distance and that
              service&apos;s own published phone number. Where no number is published, the contact
              is saved with a blank number — never a national helpline standing in for a direct
              line. Contacts you entered or edited yourself are left as they are.
            </p>

            {activeProvider() === 'osm' ? (
              <p className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <span className="font-semibold">Using OpenStreetMap.</span> It is free but
                incomplete — many stations publish no phone number, and its police and fire entries
                are sometimes mis-tagged. For reliable names and numbers, set a Google Places key (
                <code className="text-xs">VITE_GOOGLE_MAPS_API_KEY</code>) and redeploy; results
                below are worth spot-checking either way.
              </p>
            ) : (
              <p className="rounded-2xl border border-green-200 bg-green-50 p-3 text-sm text-green-900">
                <span className="font-semibold">Using Google Places</span> — curated names and
                numbers, with OpenStreetMap as an automatic fallback if the key or quota fails.
              </p>
            )}

            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-surface-200 p-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="refresh-scope"
                  checked={refreshScope === 'recompute'}
                  onChange={() => setRefreshScope('recompute')}
                />
                <span>
                  <span className="font-semibold text-ink-900">
                    Recompute mapped contacts ({recomputeTargets.length})
                  </span>
                  <span className="block text-sm text-ink-500">
                    Sites whose Hospital, Police or Fire Brigade was filled by this lookup, or is
                    missing. This is the one-off correction for contacts that are not the nearest
                    facility. Rows you typed or edited are kept.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-surface-200 p-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="refresh-scope"
                  checked={refreshScope === 'needed'}
                  onChange={() => setRefreshScope('needed')}
                />
                <span>
                  <span className="font-semibold text-ink-900">
                    Only sites missing a number ({needingRefresh.length})
                  </span>
                  <span className="block text-sm text-ink-500">
                    Sites with no external contacts yet, or whose numbers are blank or a generic
                    helpline.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-surface-200 p-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="refresh-scope"
                  checked={refreshScope === 'all'}
                  onChange={() => setRefreshScope('all')}
                />
                <span>
                  <span className="font-semibold text-ink-900">
                    All sites with coordinates ({withCoords.length})
                  </span>
                  <span className="block text-sm text-ink-500">
                    Re-checks every site. Contacts you entered by hand are kept.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-surface-200 p-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={replaceManual}
                  onChange={(e) => setReplaceManual(e.target.checked)}
                />
                <span>
                  <span className="font-semibold text-ink-900">
                    Also replace contacts I entered myself
                  </span>
                  <span className="block text-sm text-ink-500">
                    Off by default. Turn on only when the hand-entered hospital, police or fire
                    contact should be overwritten with the nearest facility.
                  </span>
                </span>
              </label>
            </div>

            {noCoords > 0 && (
              <p className="flex items-start gap-2 rounded-2xl bg-surface-100 p-3 text-sm text-ink-600">
                <MapPin size={15} className="mt-0.5 shrink-0" />
                {noCoords} site{noCoords === 1 ? ' has' : 's have'} no latitude/longitude and will
                be skipped. Add coordinates in the Sites module, then run this again.
              </p>
            )}

            <p className="text-xs text-ink-500">
              Runs one site at a time with a pause between them, because the public map servers
              rate-limit bursts — measured at roughly {activeProvider() === 'google' ? '4' : '45'}{' '}
              seconds per site, so about{' '}
              {Math.max(
                1,
                Math.round((refreshTargets.length * (activeProvider() === 'google' ? 4 : 45)) / 60)
              )}{' '}
              minute(s) for {refreshTargets.length} site{refreshTargets.length === 1 ? '' : 's'}.
              You can leave this running and carry on elsewhere; use Stop to end it early and keep
              what has been saved.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-ink-800">
                {run.summary ? 'Finished' : `Looking up ${run.current}…`}
              </span>
              <span className="text-ink-500">
                {run.done} / {run.total}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-200">
              <div
                className="h-full rounded-full bg-brand-500 transition-all duration-300"
                style={{ width: `${run.total ? (run.done / run.total) * 100 : 0}%` }}
              />
            </div>

            {run.summary && (
              <div className="rounded-2xl bg-surface-100 p-3 text-sm text-ink-700">
                <p className="font-semibold text-ink-900">
                  {run.summary.ok} site(s) refreshed
                  {run.summary.failed ? ` · ${run.summary.failed} failed` : ''}
                  {run.summary.stopped ? ' · stopped early' : ''}
                </p>
                <p className="mt-1">
                  {run.summary.added} contact(s) added, {run.summary.updated} updated
                  {run.summary.skipped
                    ? `, ${run.summary.skipped} kept because you entered them`
                    : ''}{' '}
                  ·{' '}
                  <span className="font-medium text-green-700">
                    {run.summary.withNumber} with a direct number
                  </span>
                  ,{' '}
                  <span className="font-medium text-amber-700">
                    {run.summary.withoutNumber} still need one entered manually
                  </span>
                  .
                </p>
              </div>
            )}

            <div className="max-h-64 space-y-1 overflow-auto rounded-2xl border border-surface-200 p-2 text-sm">
              {run.log.map((l, i) => (
                <div key={`${l.site}-${i}`} className="flex items-start gap-2 px-2 py-1">
                  {l.status === 'done' ? (
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-600" />
                  ) : (
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />
                  )}
                  <span className="font-medium text-ink-800">{l.site}</span>
                  <span className="text-ink-500">— {l.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
