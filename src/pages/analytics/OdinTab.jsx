// ─────────────────────────────────────────────────────────────────────────────
// Analytics → ODIN.
//
// The Safety & Security picture as the warehouse sees it: where the issues are,
// what state they are in by region, what kind of finding they are, and whether
// the sites that failed an audit had fixed anything a week later.
//
// It is the only tab that does not read Firestore. The rows come from Metabase
// through a callable, because the API key that fetches them is a bearer
// credential for an entire analytics warehouse and must never reach a browser —
// see stack/lib/metabase.js. That has two consequences visible here: the
// data is FETCHED rather than subscribed, so there is a refresh button and a
// timestamp saying how old the numbers are; and every failure mode is a
// different screen, because "nobody has connected Metabase" and "the audits
// question was deleted" need different people to do different things.
//
// The site map joins on this app's own site register for coordinates, so an
// organization does not have to add latitude and longitude columns to their
// warehouse to get a map out of it.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, Cell, LabelList,
  LineChart, Line, ReferenceLine, CartesianGrid,
} from 'recharts'
import {
  RefreshCw, ShieldAlert, MapPinOff, Radar, AlertTriangle, Plug, Loader2, CalendarRange,
  CircleCheck, CircleX, SlidersHorizontal, X, ClipboardCheck,
} from 'lucide-react'
import { MapContainer, TileLayer, Marker, Tooltip as LeafletTooltip } from 'react-leaflet'
import L from 'leaflet'
import ChartFrame from '../../shared/ui/ChartFrame'
import { metabaseQuery, metabaseSettings } from '../../shared/functions'
import MetabaseConnect from '../../shared/integrations/MetabaseConnect'
import { Panel, Stat, NoData, Picker, FilterRow, DateField } from './ui'
import {
  odinAnalytics, odinFacets, resolveOdinRows, STATUS_META, STATUS_BY_KEY, leadStatus, TICKET_OWNERS, QOQ_METRICS, quarterSpans, quarterSeries, filterOdinRows,
  GRANULARITIES, GROUP_DIMS, PASS_MARK,
} from './odinAnalytics'

const axis = { tickLine: false, axisLine: false, fontSize: 11, tick: { fill: '#8a6844' } }

const num = (v) => (v == null ? '—' : Number(v).toLocaleString())

/**
 * The rule that separates the two halves of this page.
 *
 * Scores, then the tickets those scores raised. Without the split it is
 * seventeen panels in a column and no indication that half of them count
 * audits and half count tickets — two populations that must never be added up.
 */
function BandHead({ title, note }) {
  return (
    <div className="mb-3 mt-8 flex items-baseline gap-3 border-b border-ink-100 pb-2 first:mt-0">
      <h2 className="text-[15px] font-bold tracking-tight text-ink-900">{title}</h2>
      {note && <span className="text-[11.5px] text-ink-400">{note}</span>}
    </div>
  )
}

/** How many quarters the comparison covers. One query each — see load(). */
const QUARTERS_COMPARED = 3

const EMPTY_FILTER = {
  region: 'all', entity: 'all', status: 'all', subCategory: 'all', source: 'all', from: '', to: '',
  // The estate dimensions. Offered only where the connected questions carry
  // them, so a tenant whose warehouse has no city column never sees the picker.
  city: 'all', ownership: 'all', businessLine: 'all', centerType: 'all', auditType: 'all', priority: 'all',
  // How the period charts are bucketed, and what the breakdowns group by.
  gran: 'month',
  groupBy: 'region',
}

/**
 * What a tab breaks down by before anybody chooses.
 *
 * The scores tab opens on AUDITOR, not region, and the reason is that region is
 * the one dimension on this page the warehouse does not supply. The audits
 * question carries a centre id and a city; its regions are looked up from this
 * app's site register, and measured against a real month roughly a third of
 * audits fail that lookup and belong to no region at all — present in the total,
 * absent from every region, which is how "Metabase says 80, ODIN says 60"
 * happens. `Auditor_Name` comes straight off the question and cannot fail that
 * way, so the default breakdown is one that never silently loses rows.
 *
 * The tickets question has no auditor column, so the tickets tab keeps region.
 * Defaulting it to a dimension its data cannot fill would just fall through to
 * whatever came first, which is not a default so much as an accident.
 */
const defaultGroupBy = (view) => (view === 'tickets' ? 'region' : 'auditor')

/**
 * The two readings of one audit, and why each is drawn the way it is.
 *
 * They are two measurements of the SAME audits rather than two groups, so they
 * get the categorical slots in order and the pass mark gets a plain rule.
 *
 * A third line used to run beside them — "To date", the centre's score as of
 * today. It came off because it is the one figure here that the date pickers do
 * not bound: it credits remediation from after the window and moves on every
 * refresh, so on a chart of a chosen period it was answering a different
 * question in the same visual language. Every line here is now the audits
 * between the two dates and nothing else.
 */
const TREND_SERIES = [
  { key: 'day0', label: 'On the day', color: '#2a78d6' },
  { key: 'n7', label: 'After 7 days', color: '#eb6834' },
]

/** A segmented control. Six grains is too many for a dropdown nobody opens. */
function Segments({ label, value, options, onChange }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-400">{label}</span>
      <div role="group" aria-label={label} className="tab-strip flex-wrap">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
            className={`nav-tab ${value === o.key ? 'is-on nav-tab-active' : 'nav-tab-idle'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function OdinTab({ view = 'scores', sites = [], actor, isAdmin = false, keepUnplaced = true }) {
  // Which half is on screen. The scores view still needs the findings
  // question — the centre watchlist puts tickets beside pass rates, and the
  // pass figures fall back to findings rows when the audits question carries
  // none. The tickets view needs only findings, so it runs one query instead
  // of two and arrives in about half the time.
  const showScores = view !== 'tickets'
  const showTickets = view !== 'scores'
  const [f, setF] = useState(() => ({ ...EMPTY_FILTER, groupBy: defaultGroupBy(view) }))
  const [loading, setLoading] = useState(true)
  const [findings, setFindings] = useState(null)  // { ok, rows, … } as returned
  const [audits, setAudits] = useState(null)
  const [error, setError] = useState('')
  // The connection form, offered inline. An admin looking at an empty dashboard
  // should be able to connect it from where they are standing rather than being
  // sent to another screen and back — see shared/integrations/MetabaseConnect.
  const [connecting, setConnecting] = useState(false)
  // The redacted connection, for admins only, and only to report how old the
  // API key is. On an instance that issues short-lived keys, the dashboard
  // breaking on a schedule is the thing this page can warn about before it
  // happens — see keyAge in stack/lib/metabase.js. Never the key itself:
  // metabaseConfig strips it server-side.
  const [conn, setConn] = useState(null)
  // The two quarter windows, fetched alongside the main pair — see load().
  const [qoq, setQoq] = useState(null)

  // ── Nothing runs until a period is chosen ──────────────────────────────────
  //
  // These questions declare required date variables, so SOMETHING is always
  // sent to Metabase. When the boxes were empty that something was a default
  // nobody picked, and two blank date fields read as "no filter" — which is how
  // a figure here got compared against a Metabase tab run over all of history
  // and disagreed by twenty audits. Printing the window helped; not running at
  // all until somebody says which window removes the ambiguity outright.
  //
  // It also stops the tab firing a thirty-to-sixty-second warehouse query the
  // moment it is opened, which nobody asked for either.
  const hasRange = Boolean(f.from && f.to)

  const load = useCallback(async () => {
    if (!(f.from && f.to)) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      // Both at once. The audits question is optional and its absence is a
      // panel-level message, not a page-level failure, so a rejection from
      // either must not take the other's data off the screen.
      // The window goes DOWN to Metabase rather than being applied here: both
      // of the questions this was built against declare required date
      // variables and cannot run without them, and filtering in the warehouse
      // beats shipping a year of rows so the browser can discard most of them.
      const range = { from: f.from, to: f.to }
      // ── The quarter pair rides alongside ────────────────────────────────
      //
      // Two more queries, because a comparison cannot be one: two quarters of
      // tickets is about 12MB against an 8MB response cap, so the halves have
      // to be fetched separately whatever the dates say. They run in parallel
      // with the main pair rather than after it, so the wait is the slowest
      // query and not the sum of four.
      //
      // Deliberately NOT derived from the reader's window. The panel is meant
      // to be there whichever dates they picked, and bucketing their window
      // only worked when it happened to straddle a quarter boundary.
      const spans = quarterSpans(Date.now(), QUARTERS_COMPARED)
      const [fRes, aRes, ...qRes] = await Promise.all([
        metabaseQuery('findings', range),
        // Skipped entirely on the tickets view rather than fetched and
        // ignored: this is a thirty-to-sixty-second warehouse query.
        showScores ? metabaseQuery('audits', range) : Promise.resolve(null),
        // One query per quarter. They cannot be one: a quarter of tickets is
        // about 6MB and the response cap is 8, so three quarters travel as
        // three responses or not at all. All in the same Promise.all as the
        // main pair, so the wait is the slowest of five rather than their sum,
        // and none of them runs on the scores tab.
        //
        // A failure is caught rather than thrown — the rest of the tab is worth
        // more than this panel — but it is KEPT, not swallowed. Returning null
        // on failure is what made the panel able to disappear without saying
        // anything, which is the one behaviour this dashboard keeps being
        // caught out by.
        ...spans.all.map((s) => (showTickets
          ? metabaseQuery('findings', s).catch((e) => ({ ok: false, message: e?.message }))
          : Promise.resolve(null))),
      ])
      setFindings(fRes)
      setAudits(aRes)
      const bad = qRes.find((r) => r && !r.ok)
      setQoq(!showTickets ? null : {
        spans,
        rowSets: qRes.map((r) => (r?.ok ? r.rows : [])),
        failed: bad ? (bad.message || 'Metabase did not return the quarter windows.') : null,
      })
      // Admin-only and never fatal: a failure here costs a rotation warning,
      // not the dashboard, so it must not reach the catch below.
      if (isAdmin) {
        try { setConn((await metabaseSettings()).config) } catch { /* the warning is a nicety */ }
      }
    } catch (e) {
      setError(e?.message || 'Could not reach the ODIN connector.')
    } finally {
      setLoading(false)
    }
    // Changing either end of the range re-runs the questions. A date input
    // commits on blur rather than per keystroke, so this is one fetch per
    // deliberate act, not one per character.
  }, [isAdmin, f.from, f.to, showScores, showTickets])

  useEffect(() => { load() }, [load])

  // Memoised rather than computed inline: `?? []` mints a fresh array on every
  // render, which would make the useMemos below dependencies-changed every
  // time and re-run the whole aggregation on each keystroke in the filter bar.
  const findingRows = useMemo(() => (findings?.ok ? findings.rows : []), [findings])
  const auditRows = useMemo(() => (audits?.ok ? audits.rows : []), [audits])

  // Facets come from every row, not the filtered set — options that vanish as
  // you use them make a filter bar impossible to reason about.
  const opts = useMemo(
    () => odinFacets(resolveOdinRows(findingRows, sites, { keepUnplaced })),
    [findingRows, sites, keepUnplaced]
  )
  const a = useMemo(
    () => odinAnalytics(findingRows, auditRows, sites, f, { keepUnplaced }),
    [findingRows, auditRows, sites, f, keepUnplaced]
  )

  // The quarter pair, put through the SAME scope filters as everything else —
  // region, entity, audit type, sub-category — minus the dates, which are the
  // one thing the two quarter windows define for themselves. A panel that
  // ignored the filter bar would answer a different question from the charts
  // above it while sitting on the same screen.
  const qoqPair = useMemo(() => {
    if (!qoq) return null
    // A failure is carried, not converted into absence: the panel says why it
    // has no quarters rather than vanishing off the page.
    if (qoq.failed) return { failed: qoq.failed, spans: qoq.spans }
    const scope = { ...f, from: '', to: '' }
    const prep = (rows) => filterOdinRows(resolveOdinRows(rows, sites, { keepUnplaced }), scope)
    return quarterSeries(qoq.rowSets.map(prep), qoq.spans)
  }, [qoq, sites, f, keepUnplaced])

  if (loading && !findings && f.from && f.to) {
    return (
      <div className="card grid place-items-center px-6 py-16 text-center">
        <Loader2 size={22} className="animate-spin text-brand-600" />
        <p className="mt-3 text-[13px] text-ink-500">Running your Metabase questions…</p>
      </div>
    )
  }

  // Connecting takes over the tab. It is a form with an API key in it; leaving
  // half a dashboard behind it would put a credential field next to numbers
  // fetched with the credential it is about to replace.
  const connectPanel = (
    <div className="mx-auto max-w-2xl animate-fade-in-up">
      <MetabaseConnect
       
        actor={actor}
        compact
        onSaved={() => { setConnecting(false); load() }}
      />
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          onClick={() => setConnecting(false)}
          className="inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-[12.5px] font-semibold text-ink-500 hover:text-ink-800"
        >
          <X size={14} /> Cancel
        </button>
      </div>
    </div>
  )

  if (connecting && isAdmin) return connectPanel

  if (error) return <Blocked title="The ODIN connector did not answer" body={error} />

  if (findings && !findings.ok) {
    return (
      <Blocked
        {...findingsBlock(findings, isAdmin)}
        onRetry={load}
        onConnect={isAdmin ? () => setConnecting(true) : null}
        connectLabel={findings.reason === 'not-configured' ? 'Connect Metabase' : 'Connection settings'}
      />
    )
  }

  const t = a.totals

  // ── The two headline rows ──────────────────────────────────────────────────
  //
  // This used to be one row of five: issues in scope and a tile per status. It
  // answered "how big is the backlog" and nothing else — you could read every
  // tile and still not know whether the estate passes its audits, which is the
  // question the page exists for.
  //
  // Two rows now, one per band. Scores first, because a ticket only means
  // anything as the consequence of a failed check. Every tile is null-safe: a
  // question that carries no pass data leaves the score row showing dashes
  // rather than a confident zero.
  const rec = a.recovery
  const day0 = rec.stages[0]
  const n7 = rec.stages[1]
  const recovered = n7?.rate != null && day0?.rate != null ? Math.round((n7.rate - day0.rate) * 10) / 10 : null
  const failing = rec.total && n7 ? rec.total - n7.passed : null

  // ── Counts lead, percentages follow ────────────────────────────────────────
  //
  // These tiles were percentages with nothing behind them, and a percentage on
  // its own is not a number anyone can act on: 67.3% is a mood, "560 passed,
  // 272 failed" is a list of centres to visit. The rate is still here, one line
  // down, because it is what you compare between months.
  const pctOf = (n) => (rec.total ? `${Math.round((n / rec.total) * 1000) / 10}% of ${num(rec.total)}` : undefined)

  const AUDIT_KPIS = [
    { key: 'audits', icon: ClipboardCheck, label: 'Audits completed', value: num(a.auditCount || rec.total), tone: '#0d9488' },
    {
      key: 'n7pass', icon: CircleCheck, label: 'Passed after 7 days',
      value: n7 ? num(n7.passed) : '—',
      sub: n7?.rate == null ? undefined : pctOf(n7.passed),
      tone: '#22c55e',
    },
    {
      key: 'n7fail', icon: CircleX, label: 'Failed after 7 days',
      value: failing == null ? '—' : num(failing),
      sub: failing == null ? undefined : pctOf(failing),
      tone: '#ef4444',
    },
    {
      key: 'day0', icon: Radar, label: 'Passed on the day',
      value: day0 ? num(day0.passed) : '—',
      // The delta is the whole argument for the seven-day window, so it rides
      // on the tile the window is measured against.
      sub: [day0?.rate == null ? null : pctOf(day0.passed),
        recovered == null ? null : `${recovered > 0 ? '+' : ''}${recovered} pts by day 7`]
        .filter(Boolean).join(' · ') || undefined,
      tone: '#f59e0b',
    },
  ]

  // Rejected is neither closed nor outstanding, so it comes off the total
  // before "still open" — counting a dismissed finding as work in hand is how
  // a backlog figure stops meaning anything.
  const openTickets = t.total - t.closed - t.rejected
  const codeRed = (a.byPriority || []).find((p) => /red/i.test(p.name))
  const TICKET_KPIS = [
    {
      key: 'raised', icon: ShieldAlert, label: 'Tickets raised', value: num(t.total),
      // All three outcomes on one line, because they have to add up to the
      // number above them and a reader should be able to check that.
      sub: [`${num(t.closed)} closed`, `${num(openTickets)} open`, t.rejected ? `${num(t.rejected)} rejected` : null]
        .filter(Boolean).join(' · '),
      tone: '#0d9488',
    },
    {
      key: 'open', icon: AlertTriangle, label: 'Still open', value: num(openTickets),
      sub: a.ageing?.ageing?.length
        ? `oldest queue averaging ${Math.max(...a.ageing.ageing.map((x) => x.days || 0)).toLocaleString()} days`
        : undefined,
      tone: '#f59e0b',
    },
    {
      key: 'breach', icon: AlertTriangle, label: 'SLA breached', value: num(a.breached),
      sub: t.total ? `${Math.round((a.breached / t.total) * 100)}% of tickets in view` : undefined,
      tone: '#ef4444',
    },
    { key: 'red', icon: ShieldAlert, label: 'Code red open', value: codeRed ? num(codeRed.open) : '—', sub: codeRed ? `${num(codeRed.value)} raised` : undefined, tone: '#dc2626' },
  ]

  const fetchedAt = findings?.fetchedAt ? new Date(findings.fetchedAt) : null
  const groupLabel = (GROUP_DIMS.find((d) => d.key === a.groupBy)?.label || 'group').toLowerCase()

  // The window the questions ACTUALLY ran over, as reported by the connector
  // rather than as typed into the boxes above.
  //
  // These questions declare required date variables, so something is always
  // sent — and when the boxes are empty that something is a default the reader
  // never chose and could not see. Two empty date fields read as "no filter",
  // so the figures got compared against a Metabase tab run over all of history
  // and disagreed, which is a fault in the dashboard and not in the reader.
  const ran = findings?.range || audits?.range || null

  return (
    <div className="animate-fade-in-up">
      {/* ── The filter bar ──────────────────────────────────────────────────
          Six controls, and that is the whole list: a period, the two groupings
          this app's own site register fills in, and which kind of audit.

          It carried thirteen before — instance, city, business line, ownership,
          centre type, status, priority, sub-category — and the answer to "which
          of these do I need" was almost always none of them. A filter nobody
          reaches for still has to be read past every time somebody looks for
          the date. The dimensions that went are all still reachable as a
          breakdown, which is what people actually wanted them for.

          Identical on all three tabs, so moving between them does not move the
          controls. */}
      <div className="card mb-5 divide-y divide-surface-100 p-0">
        <FilterRow label="Period">
          <DateField
            id="odin-from" label="From" value={f.from} min={opts.minDate} max={f.to || opts.maxDate}
            onChange={(v) => setF({ ...f, from: v })}
          />
          <DateField
            id="odin-to" label="To" value={f.to} min={f.from || opts.minDate} max={opts.maxDate}
            onChange={(v) => setF({ ...f, to: v })}
          />
          <Segments
            label="Granularity"
            value={f.gran}
            options={GRANULARITIES}
            onChange={(gran) => setF({ ...f, gran })}
          />

          {/* Pinned right, away from the filters: these act on everything
              rather than narrowing anything. */}
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <button
              type="button"
              onClick={() => setF({ ...EMPTY_FILTER, groupBy: defaultGroupBy(view) })}
              className="rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={load}
              disabled={loading || !hasRange}
              title={hasRange ? undefined : 'Set a From and To date first'}
              className="inline-flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setConnecting(true)}
                title="Metabase connection settings"
                className="inline-flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-500 shadow-elev-sm hover:text-ink-800"
              >
                <SlidersHorizontal size={14} /> Connection
              </button>
            )}
          </div>
        </FilterRow>

        <FilterRow label="Scope">
          <Picker id="odin-region" label="Region" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })}>
            <option value="all">All regions</option>
            {opts.regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </Picker>
          <Picker id="odin-entity" label="Entity" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>
            <option value="all">All entities</option>
            {opts.entities.map((r) => <option key={r} value={r}>{r}</option>)}
          </Picker>
          <Picker id="odin-auditType" label="Type of audit" value={f.auditType} onChange={(e) => setF({ ...f, auditType: e.target.value })}>
            <option value="all">All audit types</option>
            {opts.auditTypes.map((v) => <option key={v} value={v}>{v}</option>)}
          </Picker>
        </FilterRow>

        {/* Sub-category is the one ticket-only cut that earns its place: it is
            what KIND of defect was raised, which is the question asked of a
            remediation queue more than any other. It has no meaning for an
            audit — odinAnalytics never applies it to the audit population — so
            it appears on this tab and no other, rather than sitting inert on
            the scores tab the way it used to. */}
        {showTickets && opts.subCategories.length > 1 && (
          <FilterRow label="Tickets">
            <Picker id="odin-sub" label="Sub-category" value={f.subCategory} onChange={(e) => setF({ ...f, subCategory: e.target.value })}>
              <option value="all">All sub-categories</option>
              {opts.subCategories.map((r) => <option key={r} value={r}>{r}</option>)}
            </Picker>
          </FilterRow>
        )}

        {/* A display control, not a filter, so it keeps its own line and its
            own word. It is what the removed dimensions became: city, business
            line, ownership and centre type are all still here, as a breakdown
            rather than as eight more dropdowns. */}
        {a.dimensions.length > 1 && (
          <FilterRow label="Show">
            <Picker id="odin-groupby" label="Break down by" value={a.groupBy} onChange={(e) => setF({ ...f, groupBy: e.target.value })}>
              {a.dimensions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </Picker>
          </FilterRow>
        )}
      </div>

      {/* No period, no figures. See hasRange above: a number drawn over a
          window nobody chose is the thing this whole tab got wrong once. */}
      {!hasRange && <ChoosePeriod />}

      {/* Every caveat that would make a number on this page mean something
          other than what it looks like. Above the charts, because a reader has
          to see them before the figure, not after it. */}
      {hasRange && <KeyExpiry conn={conn} onConnect={isAdmin ? () => setConnecting(true) : null} />}

      {hasRange && <Caveats findings={findings} audits={audits} totals={t} coverage={a.coverage} showScores={showScores} />}

      {hasRange && showScores && <BandHead title="Audit scores" note={`Against the ${PASS_MARK}% pass mark`} />}

      {hasRange && showScores && (
        <>
          <div className="mb-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {AUDIT_KPIS.map(({ key, ...s }) => <Stat key={key} {...s} />)}
          </div>
          <p className="mb-5 text-[11.5px] leading-relaxed text-ink-400">
            From Metabase{fetchedAt ? `, as at ${fetchedAt.toLocaleString()}` : ''}.
            {ran && <> Covering <strong className="font-semibold text-ink-600">{ran.from} to {ran.to}</strong>
              {!f.from && !f.to && ' — the default window, because the date boxes are empty'}.</>}
            {' '}A snapshot, not a live feed — press Refresh to run the questions again.
          </p>

          <TrendPanel trend={a.trend} gran={f.gran} source={a.passSource} />

          <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
            <RecoveryPanel recovery={a.recovery} />
            <DistributionPanel distribution={a.distribution} />
          </div>

          <PassRates
            audits={audits}
            byGroup={a.passByGroup}
            groupLabel={groupLabel}
            overall={a.passOverall}
            source={a.passSource}
            isAdmin={isAdmin}
            onConnect={isAdmin ? () => setConnecting(true) : null}
          />

          <Watchlist rows={a.watchlist} join={a.join} />
        </>
      )}

      {hasRange && showTickets && <BandHead title="Remediation tickets" note={showScores ? 'Raised by the audits above' : 'Raised by the FLS audits'} />}

      {hasRange && showTickets && (
        <>
          <div className="mb-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TICKET_KPIS.map(({ key, ...s }) => <Stat key={key} {...s} />)}
          </div>
          <p className="mb-5 text-[11.5px] leading-relaxed text-ink-400">
        One row per ticket the audits raised. Bucketed on the date the defect was RAISED, not
        the date it closed — the two are different clocks.
            {ran && <> Covering <strong className="font-semibold text-ink-600">{ran.from} to {ran.to}</strong>
              {!f.from && !f.to && ' — the default window, because the date boxes are empty'}
              ; a Metabase tab run over a different window will not agree with these figures.</>}
          </p>

          <TicketTrendPanel tickets={a.tickets} gran={f.gran} breached={a.breached} />

          {/* The three ages first, because "how long is this taking" is the
              question the rest of the panel then breaks down. */}
          <AgeSummary ageing={a.ageing} />

          <AgeingPanel ageing={a.ageing} />

          <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <SlaPanel rows={a.bySla} breached={a.breached} total={t.total} />
        <PriorityPanel rows={a.byPriority} />
          </div>

          <CheckpointPanel rows={a.byCheckpoint} />
        </>
      )}

      {hasRange && showTickets && <BandHead title="Observations" note="Per site, and who owns them" />}

      {hasRange && showTickets && <ObservationsPanel observations={a.observations} />}

      {hasRange && showTickets && <FlsPanel fls={a.fls} />}

      {hasRange && showTickets && <QoqPanel qoq={qoqPair} />}

      {hasRange && showTickets && <BandHead title="Where" note="Every site in scope, busiest first" />}

      {hasRange && showTickets && (
        <>
          {/* ── Sites and their issues ─────────────────────────────────────
              A list, not a map.

              The map could only draw a site it had coordinates for, and the
              tickets question carries none — they came from the site register,
              where most partner gyms have never had a latitude put on them. So
              it drew about 76 sites short of the estate and captioned itself
              with an apology naming the ones it had dropped. Everything anybody
              actually read off it — which sites, how many issues, how many
              still open — is a list, and a list can show all of them. */}
          <IssueMap cities={a.cities} sites={{ pins: a.pins, unplaced: a.unplaced }} />
          <SiteIssueList rows={a.siteIssues} />

          <Panel
            title={`Status by ${groupLabel}`}
            subtitle={`Open, In Progress, On Hold and Closed — busiest ${groupLabel} first`}
            className="mb-5"
          >
            {a.statusByGroup.length === 0 ? (
              <NoData>No issues in this scope.</NoData>
            ) : (
              <ChartFrame
                label="Safety and security issues by region and status"
                width="100%"
                height={Math.max(260, a.statusByGroup.length * 42 + 60)}
              >
                <BarChart data={a.statusByGroup} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                  <XAxis type="number" allowDecimals={false} {...axis} />
                  <YAxis type="category" dataKey="region" width={120} {...axis} />
                  <Tooltip cursor={{ fill: 'rgba(227,204,191,0.35)' }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  {STATUS_META.map((s) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label} stackId="s" fill={s.color} />
                  ))}
                </BarChart>
              </ChartFrame>
            )}
          </Panel>

          <div className="mb-5">
            <Panel title="Sub-category of finding" subtitle="Every sub-category, most frequent first">
              {a.bySubCategoryAll.length === 0 ? (
                <NoData>Nothing to show.</NoData>
              ) : (
                <ChartFrame
                  label="Findings by sub-category"
                  width="100%"
                  height={Math.max(260, a.bySubCategoryAll.length * 30 + 50)}
                >
                  <BarChart data={a.bySubCategoryAll} layout="vertical" margin={{ top: 8, right: 32, left: 8, bottom: 0 }}>
                    <XAxis type="number" allowDecimals={false} {...axis} />
                    <YAxis type="category" dataKey="name" width={170} {...axis} />
                    <Tooltip cursor={{ fill: 'rgba(227,204,191,0.35)' }} />
                    <Bar dataKey="value" name="Findings" radius={[0, 6, 6, 0]}>
                      {a.bySubCategoryAll.map((d) => <Cell key={d.name} fill={d.color} />)}
                      <LabelList dataKey="value" position="right" style={{ fontSize: 11, fill: '#8a6844' }} />
                    </Bar>
                  </BarChart>
                </ChartFrame>
              )}
            </Panel>
          </div>
        </>
      )}

    </div>
  )
}

// ── Over time ────────────────────────────────────────────────────────────────

const GRAN_LABEL = Object.fromEntries(GRANULARITIES.map((g) => [g.key, g.label.toLowerCase()]))

/**
 * Pass rate over time, at the grain the reader picked.
 *
 * Two charts, not one with two axes. The rate and the count are different
 * scales, and putting them on one plot with two y-axes invents a relationship
 * out of where the scales happen to line up — so the rate is a line chart and
 * the counts behind it are a stacked bar chart directly beneath, sharing an
 * x-axis by being the same buckets in the same order.
 *
 * The counts are not optional decoration. A bucket holding two audits swings
 * between 0% and 100% on a single result, and a rate with no denominator beside
 * it is exactly how that gets read as a collapse.
 */
function TrendPanel({ trend, gran, source }) {
  const { series, undated } = trend
  const grain = GRAN_LABEL[gran] || 'period'

  if (source === 'none' || series.length === 0) return null

  return (
    <Panel
      title="Pass rate over time"
      subtitle={`Share of audits at or above ${PASS_MARK}%, by ${grain}`}
      className="mb-5"
    >
      <ChartFrame label="Pass rate over time" width="100%" height={260}>
        <LineChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#eee6dd" vertical={false} />
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={28} />
          <YAxis domain={[0, 100]} unit="%" {...axis} width={44} />
          <Tooltip
            cursor={{ stroke: '#c9b8a6' }}
            formatter={(v, n) => [v == null ? '—' : `${v}%`, n]}
            labelFormatter={(l) => {
              const b = series.find((s) => s.label === l)
              return b ? `${l} · ${b.audits} audit${b.audits === 1 ? '' : 's'}` : l
            }}
          />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 11 }} />
          {/* The pass mark, solid. A dashed rule reads as a projection. */}
          <ReferenceLine y={PASS_MARK} stroke="#a8a29e" strokeWidth={1.5} />
          {TREND_SERIES.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '4 3' : undefined}
              dot={false}
              activeDot={{ r: 4 }}
              // A period nobody audited is a gap, not a dive to zero.
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ChartFrame>

      <p className="mb-1 mt-4 text-[11.5px] font-semibold text-ink-600">
        The audits behind it
      </p>
      <ChartFrame label="Audits by verdict over time" width="100%" height={150}>
        <BarChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={28} />
          <YAxis allowDecimals={false} {...axis} width={44} />
          <Tooltip cursor={{ fill: 'rgba(227,204,191,0.35)' }} />
          <Bar dataKey="pass" name="Pass" stackId="v" fill="#0ca30c" />
          <Bar dataKey="fail" name="Fail" stackId="v" fill="#d03b3b" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ChartFrame>

      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
        <b>On the day</b> credits no remediation. <b>After 7 days</b> re-scores a failed critical
        checkpoint as a pass where its ticket closed within seven days of being raised. Both are
        measured from the audits between the dates you chose, and nothing outside them.
        {undated > 0 && (
          <> {undated.toLocaleString()} audit{undated === 1 ? ' carries' : 's carry'} no date and
          {undated === 1 ? ' is' : ' are'} in none of these buckets.</>
        )}
      </p>
    </Panel>
  )
}

/** Tickets raised per period, split by where they now stand. */
function TicketTrendPanel({ tickets, gran, breached }) {
  const { series, undated } = tickets
  if (series.length === 0) return null
  const total = series.reduce((n, s) => n + s.total, 0)

  return (
    <Panel
      title="Remediation tickets raised"
      subtitle={`By the ${GRAN_LABEL[gran] || 'period'} the defect was raised, split by where it stands now`}
      className="mb-5"
      right={
        breached > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 px-2.5 py-1 text-[11px] font-semibold text-red-600">
            <AlertTriangle size={12} /> {breached.toLocaleString()} SLA breached
          </span>
        ) : null
      }
    >
      <ChartFrame label="Tickets raised over time" width="100%" height={220}>
        <BarChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#eee6dd" vertical={false} />
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={28} />
          <YAxis allowDecimals={false} {...axis} width={44} />
          <Tooltip cursor={{ fill: 'rgba(227,204,191,0.35)' }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="closed" name="Closed" stackId="t" fill="#0ca30c" />
          <Bar dataKey="open" name="Still open" stackId="t" fill="#fab219" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ChartFrame>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
        Bucketed on the date the defect was RAISED, not the date it closed — the two are different
        clocks, and mixing them into one bar produces a backlog chart that says nothing.
        {' '}{total.toLocaleString()} ticket{total === 1 ? '' : 's'} in scope.
        {undated > 0 && <> {undated.toLocaleString()} carry no date and are in none of these bars.</>}
      </p>
    </Panel>
  )
}

// ── The FLS panels ───────────────────────────────────────────────────────────
//
// Everything here is fed by a column a findings or audits question MAY carry
// and often does not, so each renders NOTHING at all when its column is absent
// rather than an empty frame. A panel captioned "no data" for a tenant who was
// never going to have that column is furniture on every load, forever.

/**
 * What the seven-day window recovers.
 *
 * An ordered progression, so one hue stepped rather than three unrelated
 * colours, and the steps start dark enough to hold contrast on the surface.
 * The shared denominator sits under every bar: "2,157 passed" is not a number
 * anyone can act on without the total beside it.
 */
const RECOVERY_STEPS = ['#86b6ef', '#2a78d6', '#184f95']

function RecoveryPanel({ recovery }) {
  if (!recovery?.total) return null
  const { total, stages } = recovery
  return (
    <Panel
      title="What the 7-day window recovers"
      subtitle="The same audits counted twice, as remediation is credited"
    >
      <div className="space-y-4">
        {stages.map((st, i) => (
          <div key={st.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] font-medium text-ink-700">{st.label}</span>
              <span className="text-[13px] font-bold tabular-nums text-ink-900">
                {st.rate == null ? '—' : `${st.rate}%`}
              </span>
            </div>
            <div className="mt-1.5 h-3.5 overflow-hidden rounded-full bg-surface-100">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-emil"
                style={{ width: `${Math.max(1, st.rate || 0)}%`, background: RECOVERY_STEPS[i] || RECOVERY_STEPS[2] }}
              />
            </div>
            <p className="mt-1 text-[11px] tabular-nums text-ink-400">
              {st.passed.toLocaleString()} of {total.toLocaleString()}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11.5px] leading-relaxed text-ink-500">
        A failed critical checkpoint counts as a pass once its ticket closes inside seven days of
        being raised. The gap between the two bars is what that window bought, across the audits
        between the dates you chose.
      </p>
    </Panel>
  )
}

/** Audits by score band. Pass and fail are STATES, so they take status colours. */
function DistributionPanel({ distribution }) {
  if (!distribution?.scored) return null
  const { bands, scored } = distribution
  const max = Math.max(1, ...bands.map((b) => b.value))
  return (
    <Panel title="Score distribution" subtitle={`${scored.toLocaleString()} audits, after the 7-day window`}>
      <div className="space-y-2">
        {bands.map((b) => (
          <div key={b.name} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-right text-[11.5px] tabular-nums text-ink-500">{b.name}</span>
            <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-surface-100">
              <div
                className="h-full rounded-full"
                style={{ width: `${(b.value / max) * 100}%`, background: b.passing ? '#0ca30c' : '#d03b3b' }}
              />
            </div>
            <span className="w-12 shrink-0 text-right text-[12px] font-semibold tabular-nums text-ink-800">
              {b.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11.5px] leading-relaxed text-ink-500">
        The two bands either side of {PASS_MARK}% are the ones worth chasing — a near miss is a
        different problem from a collapse, and an even histogram hides which one you have.
      </p>
    </Panel>
  )
}

/**
 * How long tickets take, in days.
 *
 * Two measurements, kept apart on purpose, because they are not the same kind
 * of number and averaging them together produces one that improves when work
 * is abandoned.
 *
 *   TIME TO CLOSE is a finished duration — raised to closed — and exists only
 *   for tickets that got there.
 *
 *   AGE is how long the ones that did not have been waiting, and it grows
 *   every day nobody touches them. A queue whose average age is climbing is
 *   the thing this panel exists to make visible.
 *
 * Rejected sits with the ageing rows rather than with closed: it was never
 * remediated, so counting it as a closure would flatter every figure here.
 */
/**
 * Every metric on this tab, quarter by quarter, with the last change.
 *
 * The quarters come out of the rows already fetched, so a comparison exists
 * only when the chosen window spans two of them. When it does not, this says so
 * rather than drawing a change against nothing — a "0%" beside a quarter that
 * was never measured is worse than an empty panel.
 *
 * Only the ages are coloured. A count moving is genuinely ambiguous: more
 * observations can mean a worse estate or simply more auditing, and this page
 * cannot tell those apart, so it does not pretend to. A ticket waiting longer
 * is worse whichever way the volume moved, so those get a direction.
 */
function QoqPanel({ qoq }) {
  if (!qoq) return null
  // Said out loud. This panel runs two queries of its own, and when they fail
  // the alternative to a message is a section that is simply not there — which
  // reads as "not built yet" and is why this was reported as missing.
  if (qoq.failed) {
    return (
      <Panel title="Quarter on quarter" subtitle="Could not run the two quarter windows" className="mb-5">
        <NoData height={140}>
          {qoq.failed}
          {qoq.spans && ` — asked for ${qoq.spans.previous.from} to ${qoq.spans.previous.to} and ${qoq.spans.current.from} to ${qoq.spans.current.to}.`}
        </NoData>
      </Panel>
    )
  }
  if (!qoq.quarters?.length) return null
  const { quarters, latest, previous, changes, undated } = qoq
  // Every quarter fetched, oldest first, so the row reads left to right as a
  // trend. The Change column stays the most recent step: three columns show the
  // shape, one number is the thing to act on.
  const shown = quarters
  const fmt = (v, unit) => (v == null ? '—' : unit === 'days' ? `${v.toLocaleString()}d` : v.toLocaleString())

  const change = (m) => {
    const d = changes?.[m.key]
    if (d == null) return <span className="text-ink-300">—</span>
    if (d === 0) return <span className="text-ink-400">no change</span>
    const up = d > 0
    const tone = m.better === 'none'
      ? 'text-ink-600'
      : (up === (m.better === 'up')) ? 'text-emerald-600' : 'text-red-600'
    return (
      <span className={`font-semibold ${tone}`}>
        {up ? '+' : ''}{d.toLocaleString()}{m.unit === 'days' ? 'd' : ''}
      </span>
    )
  }

  return (
    <Panel
      title="Quarter on quarter"
      subtitle={`${shown.map((q) => q.name).join(' → ')}${latest.partial ? ' so far' : ''}`
        + ` · Change is ${previous.name} to ${latest.name}`}
      className="mb-5"
    >
      <div className="table-crisp overflow-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-surface">
            <tr className="text-[10.5px] uppercase tracking-wide text-ink-400">
              <th className="px-3 py-2">Metric</th>
              {shown.map((q) => (
                <th key={q.key} className="px-3 py-2 text-right">
                  {q.name}
                  {q.partial && (
                    <span className="ml-1 font-normal normal-case text-ink-300">to date</span>
                  )}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Change</th>
            </tr>
          </thead>
          <tbody>
            {QOQ_METRICS.map((m) => (
              <tr key={m.key} className="border-t border-surface-100">
                <td className="px-3 py-2 font-medium text-ink-800">{m.label}</td>
                {shown.map((q) => (
                  <td key={q.key} className="px-3 py-2 text-right tabular-nums text-ink-700">
                    {fmt(q.values[m.key], m.unit)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{change(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
        Calendar quarters, named as the audit planner names them, and{' '}
        <b>independent of the dates above</b> — this panel fetches both quarters itself, so it is
        here whichever window you are looking at.
        {qoq.spans && (
          <> {qoq.spans.previous.from} to {qoq.spans.previous.to} against {qoq.spans.current.from} to{' '}
          {qoq.spans.current.to}.
          {qoq.spans.current.partial && (
            <> <b>{latest.name} is still running</b> — {qoq.spans.current.days.toLocaleString()} days of
            it against {qoq.spans.previous.days.toLocaleString()} finished, so its counts read low
            until the quarter closes. The ages do not: they are averages, not totals.</>
          )}</>
        )}
        {' '}<b>Only the ages are coloured.</b> A count moving is ambiguous: more observations can
        mean a worse estate or simply more auditing, and this page cannot tell those apart. A
        ticket waiting longer is worse either way.
        {undated > 0 && (
          <> {undated.toLocaleString()} ticket{undated === 1 ? '' : 's'} carr{undated === 1 ? 'ies' : 'y'} no
          date and {undated === 1 ? 'is' : 'are'} in no quarter.</>
        )}
      </p>
    </Panel>
  )
}

/**
 * The FLS L2 categories: where the tickets stand, and how long they have taken.
 *
 * A table rather than a chart. Six numbers per category, three of them counts
 * and three of them durations, is a row somebody reads across — a stacked bar
 * would show the counts and hide the ages, which are the half people act on.
 *
 * Closed days is time TAKEN. Open and In Progress days are time SO FAR. Same
 * unit, different measurements, so the header says which rather than leaving a
 * reader to assume they are comparable.
 */
function FlsPanel({ fls }) {
  if (!fls?.total) {
    return (
      <Panel title="FLS categories" subtitle="Fire &amp; life-safety observations, by L2 category" className="mb-5">
        <NoData height={140}>
          No FLS observations in this scope — no L2 category in the window begins “FLS”.
        </NoData>
      </Panel>
    )
  }
  const { rows, total, open, inProgress, closed, categories } = fls
  const num = (v) => (v == null ? '—' : v.toLocaleString())
  const days = (v) => (v == null ? <span className="text-ink-300">—</span> : `${v.toLocaleString()}d`)

  return (
    <Panel
      title="FLS categories"
      subtitle={`${total.toLocaleString()} fire & life-safety observations across ${categories} L2 categor${categories === 1 ? 'y' : 'ies'} — counts, then how long each has taken`}
      className="mb-5"
    >
      <div className="table-crisp max-h-[26rem] overflow-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-[10.5px] uppercase tracking-wide text-ink-400">
              <th className="px-3 py-2">L2 category</th>
              <th className="px-3 py-2 text-right">Open</th>
              <th className="px-3 py-2 text-right">In progress</th>
              <th className="px-3 py-2 text-right">Closed</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Avg age open</th>
              <th className="px-3 py-2 text-right">Avg age in prog.</th>
              <th className="px-3 py-2 text-right">Avg time to close</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-surface-100">
                <td className="px-3 py-2 font-medium text-ink-800">{r.name}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-red-600">{num(r.open)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-amber-600">{num(r.inProgress)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{num(r.closed)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-ink-800">{num(r.total)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">{days(r.openDays)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">{days(r.inProgressDays)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">{days(r.closedDays)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink-200 text-[12.5px] font-bold">
              <td className="px-3 py-2 text-ink-800">All FLS</td>
              <td className="px-3 py-2 text-right tabular-nums text-red-600">{num(open)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-amber-600">{num(inProgress)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{num(closed)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-900">{num(total)}</td>
              {/* No pooled average across categories: a mean of means over
                  categories of wildly different size is not the estate figure
                  it looks like. The three cards above give that properly. */}
              <td className="px-3 py-2 text-right font-normal text-ink-300" colSpan={3}>see the cards above</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
        FLS only — every L2 category whose tag begins “FLS”. <b>Avg time to close</b> is how long
        those tickets took; the other two ages are how long the open ones have been waiting <em>so
        far</em>, which is a different measurement in the same unit.
        {total > open + inProgress + closed && (
          <> {(total - open - inProgress - closed).toLocaleString()} more are on hold or rejected:
          in the total, in none of the three columns.</>
        )}
      </p>
    </Panel>
  )
}

/**
 * Observations per site, and who owns them.
 *
 * One row of the tickets question is one observation, so the bar is a count of
 * rows, not a score — no pass mark, no percentage, nothing to weight.
 *
 * The owner comes off the L1 tag through ownerOf, which folds the several
 * spellings of each team into one. "Other" is drawn like the rest rather than
 * hidden: an L1 tag nobody has mapped is the row worth asking about, and a
 * chart that silently omits it is the reason nobody ever asks.
 */
function ObservationsPanel({ observations }) {
  // An empty section reads as "not built yet". If there is genuinely nothing,
  // say so rather than leaving the band heading standing over a gap.
  if (!observations?.total) {
    return (
      <Panel title="Observations per site, by owner" className="mb-5">
        <NoData height={140}>No observations in this scope.</NoData>
      </Panel>
    )
  }
  const { sites, total, byOwner, siteCount, perSite } = observations
  const shown = sites.slice(0, 20)
  const owners = TICKET_OWNERS.filter((o) => byOwner[o.key] > 0)

  return (
    <>
      <div className="mb-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={ShieldAlert} label="Observations" value={total.toLocaleString()} sub={`across ${siteCount.toLocaleString()} site${siteCount === 1 ? '' : 's'}`} tone="#dc2626" />
        <Stat icon={Radar} label="Per site" value={perSite == null ? '—' : perSite.toLocaleString()} sub="average, sites with at least one" tone="#2563eb" />
        {owners.slice(0, 2).map((o) => (
          <Stat
            key={o.key}
            icon={ClipboardCheck}
            label={`${o.label} tickets`}
            value={byOwner[o.key].toLocaleString()}
            sub={`${Math.round((byOwner[o.key] / total) * 100)}% of all · ${o.full}`}
            tone={o.color}
          />
        ))}
      </div>

      <p className="mb-5 text-[11.5px] leading-relaxed text-ink-400">
        Owner is read from the L1 tag:{' '}
        {TICKET_OWNERS.filter((o) => o.key !== 'other').map((o, i) => (
          <span key={o.key}>{i ? ', ' : ''}<b>{o.full}</b> → {o.label}</span>
        ))}
        . Spellings are folded together, so “Safety and Security”, “Safety &amp; Security”, “Center
        Manager”, “Center Management” and “Center Manager SPOC” each land on one owner. A tag
        matching none of them is counted as <b>Other</b> rather than dropped.
      </p>

      <Panel
        title="Observations per site, by owner"
        subtitle={sites.length > shown.length
          ? `Busiest ${shown.length} of ${sites.length.toLocaleString()} sites; the rest are in the list below`
          : 'Busiest first'}
        className="mb-5"
      >
        <ChartFrame label="Observations per site by owner" width="100%" height={Math.max(260, shown.length * 30 + 70)}>
          <BarChart data={shown} layout="vertical" margin={{ top: 8, right: 40, left: 8, bottom: 0 }}>
            <XAxis type="number" allowDecimals={false} {...axis} />
            <YAxis type="category" dataKey="site" width={170} {...axis} />
            <Tooltip cursor={{ fill: 'rgba(227,204,191,0.35)' }} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 10.5 }} />
            {owners.map((o, i) => (
              <Bar
                key={o.key}
                dataKey={o.key}
                name={`${o.label} — ${o.full}`}
                stackId="obs"
                fill={o.color}
                radius={i === owners.length - 1 ? [0, 4, 4, 0] : undefined}
              >
                {i === owners.length - 1 && (
                  <LabelList dataKey="total" position="right" style={{ fontSize: 10.5, fill: '#8a6844' }} />
                )}
              </Bar>
            ))}
          </BarChart>
        </ChartFrame>
      </Panel>
    </>
  )
}

/**
 * The three ages, side by side, in the order somebody asks for them.
 *
 * Closed is a duration that finished. The other two are durations still
 * running, and they are separated because Open and In Progress are one backlog
 * — a ticket somebody still owes work on — while On Hold is parked on purpose,
 * so its age measures a decision rather than a delay.
 */
function AgeSummary({ ageing }) {
  if (!ageing) return null
  const cards = [
    { key: 'closed', label: 'Average age, closed', v: ageing.closed, tone: '#059669', sub: 'time taken to close' },
    { key: 'live', label: 'Average age, open & in progress', v: ageing.openInProgress, tone: '#dc2626', sub: 'still waiting' },
    { key: 'hold', label: 'Average age, on hold', v: ageing.onHold, tone: '#7c3aed', sub: 'parked, still waiting' },
  ].filter((c) => c.v?.n > 0)
  if (!cards.length) return null

  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      {cards.map((c) => (
        <div key={c.key} className="card p-4">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-400">{c.label}</p>
          <p className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[26px] font-bold leading-none tracking-tight tabular-nums" style={{ color: c.tone }}>
              {c.v.days == null ? '—' : c.v.days.toLocaleString()}
            </span>
            <span className="text-[13px] font-semibold text-ink-500">days</span>
          </p>
          <p className="mt-1 text-[11.5px] text-ink-400">
            {c.v.n.toLocaleString()} ticket{c.v.n === 1 ? '' : 's'} · {c.sub}
          </p>
        </div>
      ))}
    </div>
  )
}

function AgeingPanel({ ageing }) {
  if (!ageing) return null
  const { closed, ageing: rows } = ageing
  if (!closed?.n && !rows?.length) return null

  const days = (v) => (v == null ? '—' : `${v.toLocaleString()}`)
  const worst = Math.max(1, closed?.days || 0, ...rows.map((r) => r.days || 0))

  return (
    <Panel
      title="How long tickets take"
      subtitle="Average days — closed tickets by how long they took, everything else by how long it has been waiting"
      className="mb-5"
    >
      {closed?.n > 0 && (
        <div className="ring-1 ring-ink-200 mb-4 rounded-2xl bg-surface-50/60 p-4 ">
          <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-400">
            Average time to close
          </p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-[26px] font-bold leading-none tracking-tight text-emerald-600">
              {days(closed.days)}
            </span>
            <span className="text-[13px] font-semibold text-ink-500">days</span>
            <span className="ml-auto text-[11.5px] text-ink-400">
              across {closed.n.toLocaleString()} closed ticket{closed.n === 1 ? '' : 's'}
            </span>
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <p className="mb-2.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-400">
            Average age, still waiting
          </p>
          <div className="space-y-3">
            {rows.map((r) => (
              <div key={r.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink-700">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                    {r.label}
                  </span>
                  <span className="text-[13px] font-bold tabular-nums text-ink-900">
                    {days(r.days)}
                    <span className="ml-1 text-[11px] font-normal text-ink-400">days</span>
                  </span>
                </div>
                <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-surface-100">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(2, ((r.days || 0) / worst) * 100)}%`, background: r.color }}
                  />
                </div>
                <p className="mt-1 text-[11px] tabular-nums text-ink-400">
                  {r.n.toLocaleString()} ticket{r.n === 1 ? '' : 's'}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="mt-4 text-[11.5px] leading-relaxed text-ink-500">
        Closed tickets are measured raised-to-closed. Everything else is measured raised-to-today,
        so those bars grow on their own until somebody acts — which is the point of showing them.
        <b> Rejected</b> is counted here rather than as a closure: the finding was dismissed, not
        fixed, and folding it into the remediation figures would credit work nobody did.
      </p>
    </Panel>
  )
}

/** Where every ticket stands against its clock. Four states, worst first. */
const SLA_ORDER = [
  { match: /open.*breach/i, name: 'Open, SLA breached', color: '#d03b3b' },
  { match: /clos.*breach/i, name: 'Closed late', color: '#ec835a' },
  { match: /open.*within/i, name: 'Open, within SLA', color: '#fab219' },
  { match: /clos.*within/i, name: 'Closed on time', color: '#0ca30c' },
]

function SlaPanel({ rows, breached, total }) {
  if (!rows?.length) return null
  const seen = new Set()
  const ordered = SLA_ORDER.map((o) => {
    const hit = rows.find((r) => o.match.test(r.name))
    if (hit) seen.add(hit.name)
    return { name: o.name, color: o.color, value: hit?.value || 0 }
  }).filter((r) => r.value)
  const other = rows.filter((r) => !seen.has(r.name)).reduce((n, r) => n + r.value, 0)
  const all = other ? [...ordered, { name: 'Unclassified', color: '#8a8781', value: other }] : ordered
  const sum = all.reduce((n, r) => n + r.value, 0)
  if (!sum) return null

  return (
    <Panel
      title="SLA position"
      subtitle="Every ticket sits in exactly one of these"
      right={
        breached > 0 && total > 0 ? (
          <span className="text-[11.5px] font-semibold text-red-600">
            {Math.round((breached / total) * 100)}% breached
          </span>
        ) : null
      }
    >
      <div className="flex h-7 overflow-hidden rounded-lg">
        {all.map((r) => (
          <div key={r.name} style={{ width: `${(r.value / sum) * 100}%`, background: r.color }} />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {all.map((r) => (
          <div key={r.name} className="flex items-center gap-2.5 text-[12.5px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
            <span className="text-ink-600">{r.name}</span>
            <span className="ml-auto font-semibold tabular-nums text-ink-900">{r.value.toLocaleString()}</span>
            <span className="w-12 text-right tabular-nums text-ink-400">
              {((r.value / sum) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/** Priority mix. Four ordered tiers, so one hue stepped, not four hues. */
const PRIORITY_STEPS = ['#0d366b', '#256abf', '#5598e7', '#9ec5f4']
const PRIORITY_ORDER = [/code.?red/i, /high/i, /medium/i, /low/i]

function PriorityPanel({ rows }) {
  if (!rows?.length) return null
  const seen = new Set()
  const ranked = PRIORITY_ORDER.map((re, i) => {
    const hit = rows.find((r) => re.test(r.name))
    if (hit) seen.add(hit.name)
    return hit ? { ...hit, color: PRIORITY_STEPS[i] } : null
  }).filter(Boolean)
  const rest = rows.filter((r) => !seen.has(r.name)).map((r) => ({ ...r, color: '#8a8781' }))
  const all = [...ranked, ...rest]
  const max = Math.max(1, ...all.map((r) => r.value))

  return (
    <Panel title="Priority mix" subtitle="Raised at each tier, and how many are still open">
      <div className="space-y-3.5">
        {all.map((r) => (
          <div key={r.name}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] font-medium text-ink-700">{r.name}</span>
              <span className="text-[13px] font-bold tabular-nums text-ink-900">{r.value.toLocaleString()}</span>
            </div>
            <div className="mt-1.5 h-3 overflow-hidden rounded-full bg-surface-100">
              <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
            </div>
            <p className="mt-1 text-[11px] tabular-nums text-ink-400">{r.open.toLocaleString()} still open</p>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/**
 * What actually fails, in the auditors own words.
 *
 * The most actionable list on the page: a checkpoint failing across the estate
 * is a specification or a supply problem, not a centre problem, and fixing it
 * once is a different and much cheaper kind of work than fixing it two hundred
 * times. This is the list that tells the two apart.
 */
function CheckpointPanel({ rows }) {
  if (!rows?.length) return null
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <Panel
      title="Most-failed checkpoints"
      subtitle="The audit question behind each ticket, most frequent first"
      className="mb-5"
    >
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.name}>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[12.5px] leading-snug text-ink-700">{r.name}</span>
              <span className="shrink-0 text-[12.5px] font-bold tabular-nums text-ink-900">
                {r.value.toLocaleString()}
                <span className="ml-1.5 font-normal text-ink-400">{r.open.toLocaleString()} open</span>
              </span>
            </div>
            <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-surface-100">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${(r.value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/**
 * Every centre in scope, worst first.
 *
 * Capped at fifty on screen, and the cap is STATED: a table that quietly stops
 * at fifty reads as "these are all of them", which is the wrong impression for
 * a watchlist above all other tables.
 */
/**
 * What the tab shows before anybody has picked a period.
 *
 * Deliberately not a spinner and not an empty chart: both would imply the page
 * had tried and found nothing. It has not tried, and it is saying so.
 */
function ChoosePeriod() {
  return (
    <div className="card grid place-items-center px-6 py-16 text-center">
      <CalendarRange size={22} className="text-brand-600" />
      <p className="mt-3 text-[14px] font-semibold text-ink-800">Choose a period to run</p>
      <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-500">
        Set a From and To date above. These questions cover the whole estate and take up to a
        minute to run, so nothing is fetched until you say which window you want — and the figures
        will then match a Metabase tab run over those same two dates.
      </p>
    </div>
  )
}

/**
 * One pin per place. Size carries the count, the ring carries the status mix,
 * and the number in the middle takes the colour of the worst status present —
 * the same grammar the CCTV and equipment maps use, so a reader who has learned
 * one map has learned all three.
 */
const pinCache = new Map()
function issuePin(pin) {
  const size = pin.total >= 100 ? 48 : pin.total >= 10 ? 42 : pin.total >= 4 ? 36 : 30
  const key = `${size}:${STATUS_META.map((s) => pin.byStatus[s.key]).join('-')}`
  if (!pinCache.has(key)) {
    let at = 0
    const stops = []
    for (const s of STATUS_META) {
      const n = pin.byStatus[s.key] || 0
      if (!n) continue
      const to = at + (n / pin.total) * 100
      stops.push(`${s.color} ${at.toFixed(1)}% ${to.toFixed(1)}%`)
      at = to
    }
    const lead = STATUS_BY_KEY[leadStatus(pin.byStatus)]?.color || '#57534e'
    const inner = size - 11
    pinCache.set(
      key,
      L.divIcon({
        className: '',
        html: `<div style="transform:translate(-50%,-50%);display:grid;place-items:center;width:${size}px;height:${size}px;border-radius:50%;background:conic-gradient(${stops.join(',')});box-shadow:0 3px 10px rgba(16,24,40,.35)"><span style="display:grid;place-items:center;width:${inner}px;height:${inner}px;border-radius:50%;background:#fff;color:${lead};font:800 ${Math.round(inner / 2.4)}px Roboto,sans-serif">${pin.total}</span></div>`,
        iconSize: [size, size],
      })
    )
  }
  return pinCache.get(key)
}

/**
 * Where the issues are, by city or by site.
 *
 * City is the default. A site pin needs that exact site to carry coordinates
 * and most partner gyms do not; a city pin needs only one located site in the
 * city, so it places nearly everything the site view drops. Site remains one
 * click away for anyone who wants the individual centre.
 */
function IssueMap({ cities, sites }) {
  const [by, setBy] = useState('city')
  const view = by === 'city' ? cities : sites
  const { pins, unplaced } = view
  const missing = unplaced.reduce((n, u) => n + u.total, 0)
  const one = unplaced.length === 1
  const placeWord = by === 'city' ? (one ? 'city' : 'cities') : (one ? 'site' : 'sites')


  return (
    <Panel
      title="Where the issues are"
      subtitle={by === 'city'
        ? 'One pin per city; the ring is its status mix, the number is how many'
        : 'One pin per site; the ring is its status mix, the number is how many'}
      className="mb-5"
      right={
        <div className="flex rounded-2xl bg-surface p-1 shadow-elev-sm">
          {[{ k: 'city', label: 'By city' }, { k: 'site', label: 'By site' }].map((o) => (
            <button
              key={o.k}
              type="button"
              onClick={() => setBy(o.k)}
              className={`rounded-xl px-3 py-1.5 text-[11.5px] font-semibold transition ${
                by === o.k ? 'bg-surface text-ink-800 shadow-elev-sm' : 'text-ink-500 hover:text-ink-700'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      }
    >
      {pins.length === 0 ? (
        <NoData height={300}>
          {unplaced.length > 0
            ? 'Issues exist, but no affected site has coordinates. Add a latitude and longitude to a site in Sites, or return them from your Metabase question.'
            : 'No issues in this scope.'}
        </NoData>
      ) : (
        <>
          <div className="overflow-hidden rounded-[18px]">
            <MapContainer
              key={by}
              center={[pins[0].lat, pins[0].lng]}
              zoom={by === 'city' ? 5 : 6}
              scrollWheelZoom
              style={{ height: 360, width: '100%' }}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {pins.map((p) => (
                <Marker key={p.id} position={[p.lat, p.lng]} icon={issuePin(p)}>
                  <LeafletTooltip direction="top" offset={[0, -14]} opacity={1}>
                    <span className="text-[12px] font-semibold">{p.site}</span>
                    {p.sites > 1 && <span className="block text-[11px]">{p.sites} sites</span>}
                    {STATUS_META.filter((s) => p.byStatus[s.key] > 0).map((s) => (
                      <span key={s.key} className="block text-[11px]">
                        {p.byStatus[s.key]} {s.label.toLowerCase()}
                      </span>
                    ))}
                    {(p.region || p.entity) && (
                      <span className="block text-[11px]">{[p.region, p.entity].filter(Boolean).join(' · ')}</span>
                    )}
                  </LeafletTooltip>
                </Marker>
              ))}
            </MapContainer>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {STATUS_META.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-600">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>

          {/* Said out loud, every time. A map showing eleven of nineteen places
              and saying nothing will be read as showing all nineteen. */}
          {unplaced.length > 0 && (
            <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-ink-500">
              <MapPinOff size={13} className="mt-0.5 flex-none" />
              {missing.toLocaleString()} issue{missing === 1 ? '' : 's'} at {unplaced.length}{' '}
              {placeWord} could not be placed:{' '}
              {unplaced.slice(0, 4).map((u) => u.site).join(', ')}
              {unplaced.length > 4 ? `, +${unplaced.length - 4} more` : ''}. They are counted in every
              chart below, and in the list underneath.
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

/**
 * Every site in scope and how many issues it carries, busiest first.
 *
 * This replaced the map. Sorted by total rather than alphabetically because the
 * question it answers is "where is the work", and that is a ranking; a site with
 * three hundred open issues should not be somewhere under S.
 */
function SiteIssueList({ rows }) {
  if (!rows?.length) {
    return (
      <Panel title="Sites and their issues" subtitle="Every site in scope, busiest first" className="mb-5">
        <NoData height={200}>No issues in this scope.</NoData>
      </Panel>
    )
  }

  const shown = rows.slice(0, 200)
  const totals = rows.reduce(
    (acc, r) => ({ total: acc.total + r.total, open: acc.open + r.open, breached: acc.breached + r.breached }),
    { total: 0, open: 0, breached: 0 },
  )

  return (
    <Panel
      title="Sites and their issues"
      subtitle="Every site in scope, busiest first"
      className="mb-5"
    >
      <div className="table-crisp max-h-[30rem] overflow-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-[10.5px] uppercase tracking-wide text-ink-400">
              <th className="px-3 py-2">Site</th>
              <th className="px-3 py-2 text-right">Issues</th>
              <th className="px-3 py-2 text-right">Open</th>
              <th className="px-3 py-2 text-right">Closed</th>
              <th className="px-3 py-2 text-right">SLA breached</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-t border-surface-100">
                <td className="px-3 py-2">
                  <span className="font-medium text-ink-800">{r.site}</span>
                  {(r.city || r.region || r.entity) && (
                    <span className="ml-1.5 text-[11px] text-ink-400">
                      {[r.city || r.region, r.entity].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-ink-800">{r.total.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">{r.open.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-500">{r.closed.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className={r.breached > 0 ? 'font-semibold text-red-600' : 'text-ink-300'}>
                    {r.breached.toLocaleString()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
        {rows.length > shown.length
          ? `Showing the ${shown.length} busiest of ${rows.length.toLocaleString()} sites. `
          : `${rows.length.toLocaleString()} site${rows.length === 1 ? '' : 's'} in scope. `}
        {totals.total.toLocaleString()} issues, {totals.open.toLocaleString()} still open,
        {' '}{totals.breached.toLocaleString()} past SLA. Every site appears — unlike the map this
        replaced, nothing here depends on a site having coordinates.
      </p>
    </Panel>
  )
}

function Watchlist({ rows, join }) {
  if (!rows?.length) return null
  const shown = rows.slice(0, 50)

  return (
    <Panel
      title="Centre watchlist"
      subtitle="Audit scores and remediation tickets per centre, worst pass rate first"
      className="mb-5"
    >
      <div className="table-crisp max-h-[26rem] overflow-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-[10.5px] uppercase tracking-wide text-ink-400">
              <th className="px-3 py-2">Centre</th>
              <th className="px-3 py-2 text-right">Audits</th>
              <th className="px-3 py-2 text-right">Pass rate</th>
              <th className="px-3 py-2 text-right">Tickets</th>
              <th className="px-3 py-2 text-right">Open</th>
              <th className="px-3 py-2 text-right">SLA breached</th>
              <th className="px-3 py-2 text-right">Code red</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-t border-surface-100">
                <td className="px-3 py-2">
                  <span className="font-medium text-ink-800">{r.site}</span>
                  {(r.city || r.region) && (
                    <span className="ml-1.5 text-[11px] text-ink-400">{r.city || r.region}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">{r.audits.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.passRate == null ? (
                    <span className="text-ink-300">—</span>
                  ) : (
                    <span className={r.passRate >= PASS_MARK ? 'font-semibold text-emerald-600' : 'font-semibold text-red-600'}>
                      {r.passRate}%
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">{r.tickets.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">{r.open.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">{r.breached.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-700">{r.red.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
        {rows.length > shown.length
          ? `Showing the ${shown.length} worst of ${rows.length.toLocaleString()} centres. `
          : `${rows.length.toLocaleString()} centre${rows.length === 1 ? '' : 's'} in scope. `}
        Audit figures come from the audits question, ticket figures from the findings question,
        joined on the site each row resolved to.
        {join?.total > 0 && join.unmatched > 0 && (
          <>
            {' '}
            {join.unmatched.toLocaleString()} of {join.total.toLocaleString()} rows matched no site
            in your register — give those sites the warehouse&apos;s centre ID in Sites and they
            will join by key instead of by name.
          </>
        )}
      </p>
    </Panel>
  )
}

// ── Pass and fail ────────────────────────────────────────────────────────────

function PassRates({ audits, byGroup, groupLabel, overall, source, isAdmin, onConnect }) {
  // Nothing anywhere carries a pass rate. That is a configuration answer, not
  // an empty chart, and it names the two places it could come from — because
  // either one will do and an admin choosing between them needs to know that.
  if (source === 'none') {
    const why = audits && !audits.ok && audits.reason !== 'no-card'
      ? audits.message || 'The audits question could not be run.'
      : 'Neither question returned pass data. Add a pass and fail count (or a pass percentage) to your findings question, or point ODIN at a separate audits question that has them.'
    return (
      <Panel title="Pass and fail — day of audit vs N+7" subtitle="No pass data yet">
        <NoData height={180}>
          {isAdmin ? why : `${why.replace(/^Add /, 'An administrator needs to add ')} `}
        </NoData>
        {isAdmin && onConnect && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={onConnect}
              className="inline-flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm"
            >
              <Plug size={14} /> Connection settings
            </button>
          </div>
        )}
      </Panel>
    )
  }

  return (
    <>
      <PassHeadline overall={overall} source={source} />
      {/* One panel with a dimension picker, rather than a fixed pair. Region
          and entity are the two this app's own site register fills in, so they
          lead — but an estate of near-identical sites is argued about by city,
          brand and operating model, and hard-coding two of nine meant the other
          seven were not askable at all. Only dimensions the data actually
          carries are offered. */}
      <PassPanel
        title={`Pass percentage by ${groupLabel}`}
        subtitle="On the day of the audit, and at the seven-day re-check"
        rows={byGroup}
      />
    </>
  )
}

/**
 * The headline pass and fail figures.
 *
 * Counts first, percentage beside them. "412 checks passed, 88 failed" is a
 * sentence a safety meeting can act on in a way "83.4%" is not — the 88 is the
 * work. The counts are omitted entirely, rather than shown as zero, when the
 * questions gave only percentages: a zero here would read as "nothing failed".
 */
function PassHeadline({ overall, source }) {
  const hasCounts = overall.checks > 0
  return (
    <Panel
      title="Pass and fail"
      subtitle={
        source === 'findings'
          ? 'From the pass/fail columns on your findings question'
          : 'From your audits question'
      }
      className="mb-5"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          icon={CircleCheck}
          label={hasCounts ? 'Checks passed' : 'Average pass rate'}
          value={hasCounts ? overall.passed.toLocaleString() : (overall.pct == null ? '—' : `${overall.pct}%`)}
          sub={hasCounts ? `${overall.pct}% of ${overall.checks.toLocaleString()} checks` : 'across every audit in scope'}
          tone="#22c55e"
        />
        {hasCounts && (
          <Stat
            icon={CircleX}
            label="Checks failed"
            value={overall.failed.toLocaleString()}
            sub="the work the pass rate is hiding"
            tone="#ef4444"
          />
        )}
        <Stat
          icon={Radar}
          label={source === 'findings' ? 'Findings with pass data' : 'Audits in scope'}
          value={overall.audits.toLocaleString()}
          sub={
            hasCounts && overall.counted < overall.audits
              ? `${overall.counted.toLocaleString()} carry check counts`
              : undefined
          }
          tone="#0d9488"
        />
      </div>
      {hasCounts && overall.counted < overall.audits && (
        // Otherwise the counts read as covering everything in scope when they
        // cover part of it, and the difference is invisible on the tile.
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
          {(overall.audits - overall.counted).toLocaleString()} of these gave a percentage but no check
          counts, so they are in the percentage and not in the totals above it.
        </p>
      )}
    </Panel>
  )
}

function PassPanel({ title, subtitle, rows }) {
  if (rows.length === 0) return <Panel title={title} subtitle={subtitle}><NoData height={180}>Nothing to show.</NoData></Panel>

  // What the bar counts, stated rather than assumed. It used to be the mean of
  // each audit's score, which is a different measurement under the same word:
  // eleven audits averaging 78% with one of them at or above the mark read
  // "78%" here and "1 of 11" in the table beside it.
  const basisNote = `The share of audits scoring ${PASS_MARK}% or more — the same measure as the headline `
    + 'figures and the table below, so a group’s bar and its pass count always agree. '
    + 'The average score itself is in the tooltip.'

  const pending = rows.filter((r) => r.n7Audits < r.audits)

  // The counts behind the bar, in the tooltip. A percentage nobody can trace
  // back to "412 of 500" is a number a reader has to take on faith, and this is
  // the one panel people argue about in a meeting.
  const tip = (v, name, item) => {
    if (v == null) return ['—', name]
    const r = item?.payload
    // The audits behind the bar, then the average score beside it. Both are
    // spelled out because they are the two numbers that used to be confused for
    // each other: the bar is how many CLEARED the mark, the average is how
    // close the rest came.
    if (name === 'N+7' && r?.n7Audits > 0) {
      const avg = Number.isFinite(r.n7Avg) ? `, averaging ${r.n7Avg}%` : ''
      return [`${v}% — ${r.auditsPassed.toLocaleString()} of ${r.n7Audits.toLocaleString()} audits at or above ${PASS_MARK}%${avg}`, name]
    }
    if (name === 'Day of audit' && r?.audits > 0) {
      const avg = Number.isFinite(r.day0Avg) ? `, averaging ${r.day0Avg}%` : ''
      return [`${v}% of audits at or above ${PASS_MARK}%${avg}`, name]
    }
    return [`${v}%`, name]
  }

  return (
    <Panel title={title} subtitle={subtitle} className="mb-5">
      <ChartFrame label={title} width="100%" height={Math.max(240, rows.length * 44 + 60)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 34, left: 8, bottom: 0 }}>
          <XAxis type="number" domain={[0, 100]} unit="%" {...axis} />
          <YAxis type="category" dataKey="name" width={120} {...axis} />
          <Tooltip formatter={tip} cursor={{ fill: 'rgba(227,204,191,0.35)' }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="day0" name="Day of audit" fill="#f59e0b" radius={[0, 5, 5, 0]}>
            <LabelList dataKey="day0" position="right" formatter={(v) => (v == null ? '' : `${v}%`)} style={{ fontSize: 10.5, fill: '#8a6844' }} />
          </Bar>
          <Bar dataKey="n7" name="N+7" fill="#0d9488" radius={[0, 5, 5, 0]}>
            <LabelList dataKey="n7" position="right" formatter={(v) => (v == null ? '' : `${v}%`)} style={{ fontSize: 10.5, fill: '#8a6844' }} />
          </Bar>
        </BarChart>
      </ChartFrame>

      <p className="mt-3 text-[11.5px] leading-relaxed text-ink-400">{basisNote}</p>
      {pending.length > 0 && (
        // Otherwise a group whose re-checks have not happened yet reads exactly
        // like one that was re-checked and scored badly.
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">
          N+7 is missing for some audits in {pending.map((r) => r.name).slice(0, 3).join(', ')}
          {pending.length > 3 ? ` and ${pending.length - 3} more` : ''} — those bars cover only the
          audits that have been re-checked, not all of them.
        </p>
      )}
    </Panel>
  )
}

// ── Caveats and blocked states ───────────────────────────────────────────────

/**
 * The API key is about to expire, or already has.
 *
 * Above everything, and only for an admin, because they are the only person who
 * can act on it. A 401 reaches an ordinary member as "the question could not be
 * run", which is true and useless; this says which of the two things is wrong
 * and puts the fix one click away.
 */
function KeyExpiry({ conn, onConnect }) {
  const age = conn?.keyAge
  if (!age?.set || !conn?.apiKeyMaxAgeDays) return null
  if (!age.stale && !(age.expiresInDays !== null && age.expiresInDays <= 1)) return null

  return (
    <div className={`card mb-5 flex flex-wrap items-center gap-3 p-4 ${age.stale ? 'ring-1 ring-red-200' : ''}`}>
      <AlertTriangle size={16} className={age.stale ? 'text-red-600' : 'text-amber-600'} />
      <div className="min-w-[16rem] flex-1">
        <p className={`text-[12.5px] font-semibold ${age.stale ? 'text-red-700' : 'text-amber-700'}`}>
          {age.stale
            ? 'The Metabase API key has expired'
            : age.expiresInDays === 1 ? 'The Metabase API key expires tomorrow' : 'The Metabase API key expires today'}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-500">
          Keys on this instance last {conn.apiKeyMaxAgeDays} day{conn.apiKeyMaxAgeDays === 1 ? '' : 's'}.
          {age.stale
            ? ' Anything on this page is from the last successful refresh. Paste a new key to bring it back.'
            : ' Rotate it now and the dashboard will not stop.'}
        </p>
      </div>
      {onConnect && (
        <button
          type="button"
          onClick={onConnect}
          className="inline-flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm"
        >
          <Plug size={14} /> Update the key
        </button>
      )}
    </div>
  )
}

function Caveats({ findings, audits, totals, coverage, showScores }) {
  const notes = []

  // ── Rows that can be counted but not placed in a region ────────────────────
  //
  // First, because it is the caveat that explains a disagreement with Metabase
  // rather than merely qualifying a number, and because the reader hits it the
  // moment they touch the Region filter. The audits question has no region
  // column; every region on this page is this app's site register, reached by
  // centre id. A row that fails that join is in the totals and in no region.
  const cov = showScores ? coverage?.audits : coverage?.findings
  const unit = showScores ? 'audit' : 'ticket'
  if (cov?.missing > 0) {
    const list = (names) => `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
    const because = [
      cov.noSite > 0 && `${cov.noSite.toLocaleString()} at centres your site register does not hold (${list(cov.noSiteCentres)}) — add the centre id to the site, or add the site`,
      cov.noRegion > 0 && `${cov.noRegion.toLocaleString()} at centres that ARE in the register but have no region recorded (${list(cov.noRegionCentres)}) — set the region on the site`,
    ].filter(Boolean)
    notes.push(
      `${cov.missing.toLocaleString()} of ${cov.total.toLocaleString()} ${unit}s carry no region, so they are counted in the totals above but disappear as soon as you pick a Region — which is why a region here can read lower than the same period in Metabase. ${because.join('. ')}.`
    )
  }

  // Instances that did not answer, named. This leads, because it is the only
  // caveat that means numbers are MISSING rather than merely qualified — a
  // dashboard quietly drawn from two of three instances is a dashboard that
  // will be read as covering the estate.
  const down = (findings?.sources || []).filter((s) => !s.ok)
  if (down.length) {
    const total = findings.sources.length
    notes.push(`These figures are from ${total - down.length} of your ${total} Metabase instances. ${down.map((s) => `${s.label}: ${s.message || s.reason}`).join(' · ')}`)
  }
  const auditsDown = (audits?.sources || []).filter((s) => !s.ok)
  if (auditsDown.length && audits?.ok) {
    notes.push(`The pass percentages are missing ${auditsDown.map((s) => s.label).join(', ')} — that instance's audits question did not answer.`)
  }

  if (findings?.capped) {
    notes.push(`These figures are incomplete. Your findings question returned ${findings.total.toLocaleString()} rows and ODIN reads the first ${findings.rows.length.toLocaleString()}. Group or filter the question in Metabase so it fits.`)
  }
  if (totals.unknown > 0) {
    // Two different faults wear the same number, and they need different
    // fixes. A row with an unfamiliar WORD needs that word mapped. A row with
    // no status at all is almost always a question in the wrong slot — the
    // audits question sitting under `findings`, whose rows are audits and have
    // no ticket status to give. Saying "does not recognise ()" for the second
    // one sent people looking for a word that was never there.
    const named = totals.unknownLabels.filter((l) => String(l || '').trim())
    notes.push(
      named.length
        ? `${totals.unknown} issue${totals.unknown === 1 ? '' : 's'} carry a status ODIN does not recognise (${named.slice(0, 4).join(', ')}${named.length > 4 ? ', …' : ''}). They are counted in the total but appear in no status bar — map them to Open, In Progress, On Hold, Closed or Rejected in your question.`
        : `${totals.unknown} row${totals.unknown === 1 ? '' : 's'} carry no status at all, so they are counted in the total but appear in no status bar. A findings question with no status column is usually the wrong question in that slot — check that your AUDITS question is set as the audits question rather than the findings one, in Connection settings.`
    )
  }
  if (findings?.unmapped?.length) {
    notes.push(`Columns ODIN made no use of: ${findings.unmapped.slice(0, 8).join(', ')}${findings.unmapped.length > 8 ? ', …' : ''}. Rename one to a name ODIN knows if it should be driving a chart.`)
  }
  if (audits?.ok && audits.capped) {
    notes.push('Your audits question also returned more rows than ODIN reads, so the pass percentages cover only part of it.')
  }
  if (notes.length === 0) return null

  return (
    <div role="status" className="mb-5 space-y-2">
      {notes.map((n) => (
        <div key={n} className="flex items-start gap-2.5 rounded-2xl bg-amber-50 px-4 py-3 shadow-elev-sm">
          <AlertTriangle size={16} className="mt-0.5 flex-none text-amber-700" />
          <p className="text-[12.5px] leading-relaxed text-amber-900">{n}</p>
        </div>
      ))}
    </div>
  )
}

/**
 * What to say when there is nothing to draw.
 *
 * Each reason gets its own words because each needs a different person to do a
 * different thing, and "something went wrong" sends everybody to the same
 * dead end.
 */
function findingsBlock(res, isAdmin) {
  const where = 'Organization settings → Integrations'
  if (res.reason === 'not-configured') {
    return {
      title: 'ODIN is not connected to Metabase yet',
      body: isAdmin
        ? `Add your Metabase URL and an API key under ${where}, then point ODIN at the saved question that lists your Safety & Security findings.`
        : `An administrator needs to connect Metabase under ${where} before this dashboard can show anything.`,
    }
  }
  if (res.reason === 'no-card') {
    return {
      title: 'No findings question is configured',
      body: isAdmin
        ? `Metabase is connected, but ODIN has not been told which saved question lists your findings. Set it under ${where}.`
        : `Metabase is connected, but nobody has told ODIN which saved question lists the findings. Ask an administrator to set it under ${where}.`,
    }
  }
  return {
    title: 'Metabase could not answer',
    body: res.message || 'The findings question did not run. Check it still exists and that the API key can read it.',
    // Metabase's own words, which the server sends only to an admin. Without
    // them "server error" names no field, no parameter and no permission —
    // there is nothing in it to act on.
    detail: res.detail,
  }
}

function Blocked({ title, body, detail, onRetry, onConnect, connectLabel = 'Connect Metabase' }) {
  return (
    <div className="card grid place-items-center px-6 py-14 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-500/10 text-brand-600">
        <Plug size={20} />
      </span>
      <p className="mt-3 text-[15px] font-bold text-ink-900">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-ink-500">{body}</p>
      {detail && (
        // Monospace and left-aligned: this is a machine's sentence, and
        // centring it as prose makes a stack-trace-shaped thing unreadable.
        <p className="ring-1 ring-ink-200 mx-auto mt-3 max-w-[62ch] rounded-xl bg-surface-50 px-3 py-2 text-left font-mono text-[11.5px] leading-relaxed text-ink-600 ">
          {detail}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {/* Leads, when it is offered. The retry is the answer to a transient
            failure; connecting is the answer to the state most people reading
            this screen are actually in. */}
        {onConnect && (
          <button
            type="button"
            onClick={onConnect}
            className="inline-flex items-center gap-2 rounded-2xl bg-brand-600 px-4 py-2.5 text-[12.5px] font-semibold text-white shadow-brand-sm transition-colors hover:bg-brand-500"
          >
            <Plug size={14} /> {connectLabel}
          </button>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm"
          >
            <RefreshCw size={14} /> Try again
          </button>
        )}
      </div>
    </div>
  )
}
