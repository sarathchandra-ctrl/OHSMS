// ─────────────────────────────────────────────────────────────────────────────
// Analytics → Auditors.
//
// Who audited what, and where. Coverage rather than compliance: the ODIN tab
// answers "is the estate safe", this one answers "did the programme actually
// run" — which auditor covered which regions, how many centres each reached,
// and whether any region is being carried by one person.
//
// It reads the same Metabase `audits` question as the ODIN tab, through the
// same callable, for the same reason: the API key is a bearer credential for a
// whole warehouse and never reaches a browser. See stack/lib/metabase.js.
//
// ── The line this page will not cross ────────────────────────────────────────
//
// The pass rate beside each auditor is the rate of the CENTRES THEY VISITED,
// and it is not a measure of the auditor. Whoever is sent to the twenty worst
// centres in the estate will post the worst number on this page. That is said
// on the page itself, not just here, because a table with a name and a
// percentage side by side gets read as a scorecard unless it says otherwise.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, LabelList } from 'recharts'
import { RefreshCw, Loader2, UserCheck, MapPin, ClipboardList, Radar, CalendarRange } from 'lucide-react'
import ChartFrame from '../../shared/ui/ChartFrame'
import { metabaseQuery } from '../../shared/functions'
import { Panel, Stat, NoData, Picker, FilterRow, DateField } from './ui'
import {
  auditorMatrix, auditPopulation, odinFacets, resolveOdinRows, filterOdinRows, paletteColor,
  GROUP_DIMS, dimensionsPresent, dimensionHasData, resolveGroupBy, PASS_MARK, regionCoverage,
} from './odinAnalytics'

const axis = { tickLine: false, axisLine: false, fontSize: 11, tick: { fill: '#8a6844' } }

// Split by CITY, not region. This tab already tracks by auditor — that is what
// its rows are — and the only question left is what colours the bars. Region
// would be the natural answer except that the audits question does not carry
// one: regions are looked up from the site register by centre id, and about a
// third of audits in a real month fail that lookup and fall into no region at
// all. City comes off the question itself, so it is the same geography without
// the silent losses. Region is still one click away in the picker.
const EMPTY = { auditType: 'all', region: 'all', entity: 'all', from: '', to: '', groupBy: 'city' }

export default function AuditorsTab({ sites = [], keepUnplaced = true }) {
  const [f, setF] = useState(EMPTY)
  const [audits, setAudits] = useState(null)
  const [findings, setFindings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Nothing runs until a period is chosen — the same rule as the other two
  // tabs. See the hasRange note in OdinTab.jsx: an empty date box reads as "no
  // filter" while actually sending a default nobody picked, and that is what
  // made these figures disagree with Metabase in the first place.
  const hasRange = Boolean(f.from && f.to)

  const load = useCallback(async () => {
    if (!(f.from && f.to)) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      // Bounded in the warehouse — see metabaseQuery. Both questions declare
      // required date variables and cannot be run without them.
      //
      // BOTH are fetched because the audits may arrive on either: a tenant
      // whose audit question is configured under `findings` still has audit
      // rows, and asking only for `audits` is what made this tab report
      // 'no saved question with that ID' beside an N+7 tab drawing 832 of them.
      const range = { from: f.from, to: f.to }
      const [aRes, fRes] = await Promise.all([
        metabaseQuery('audits', range).catch(() => null),
        metabaseQuery('findings', range).catch(() => null),
      ])
      setAudits(aRes)
      setFindings(fRes)
    } catch (e) {
      setError(e?.message || 'Could not reach the ODIN connector.')
    } finally {
      setLoading(false)
    }
  }, [f.from, f.to])

  useEffect(() => { load() }, [load])

  // The audits, from whichever question actually carried them — see
  // auditPopulation. `source` says which, and the page states it, because one
  // row per audit and one row per checklist line are different populations.
  const population = useMemo(
    () => auditPopulation(findings?.ok ? findings.rows : [], audits?.ok ? audits.rows : []),
    [findings, audits],
  )
  const rows = population.rows
  const resolved = useMemo(
    () => resolveOdinRows(rows, sites, { keepUnplaced }),
    [rows, sites, keepUnplaced]
  )
  // Facets from every row, never the filtered set — options that disappear as
  // you use them make a filter bar impossible to reason about.
  const opts = useMemo(() => odinFacets(resolved), [resolved])
  const dims = useMemo(() => dimensionsPresent(resolved).filter((d) => d.key !== 'auditor'), [resolved])

  const filtered = useMemo(() => filterOdinRows(resolved, f), [resolved, f])
  // Measured on `resolved`, before the filter: an audit with no region drops
  // out the instant a region is picked, so measuring after the filter reports
  // zero at exactly the moment the number matters. See regionCoverage.
  const cov = useMemo(() => regionCoverage(resolved), [resolved])
  // Region unless the data has no regions — see resolveGroupBy. Grouping by a
  // dimension the picker does not even offer is how you get one bar labelled
  // "(not stated)".
  const groupBy = resolveGroupBy(dims, f.groupBy)
  // The tail is folded into one band past eight groups — see auditorMatrix.
  // The label names the dimension so "Other (21 cities)" reads as a sentence.
  const m = useMemo(
    () => auditorMatrix(filtered, groupBy, { otherLabel: plural(GROUP_DIMS.find((d) => d.key === groupBy)?.label || 'groups').toLowerCase() }),
    [filtered, groupBy],
  )

  if (loading && !audits && f.from && f.to) {
    return (
      <div className="card grid place-items-center px-6 py-16 text-center">
        <Loader2 size={22} className="animate-spin text-brand-600" />
        <p className="mt-3 text-[13px] text-ink-500">Running your audits question…</p>
      </div>
    )
  }

  if (error) return <Blocked title="The ODIN connector did not answer" body={error} onRetry={load} />

  // Blocked only when NOTHING carried an audit. A failed `audits` query is
  // survivable when the findings question turns out to hold the audit rows,
  // which is how a real tenant had it configured.
  if (population.source === 'none' && (audits?.ok === false || findings?.ok === false)) {
    const bad = audits?.ok === false ? audits : findings
    return (
      <Blocked
        title={bad.reason === 'not-configured' ? 'Metabase is not connected yet' : 'No audit data came back'}
        body={
          bad.reason === 'no-card'
            ? 'ODIN has no audits question configured. An administrator can point one at it from the Connection settings on the N+7 Pass tab.'
            : `${bad.message || 'Metabase could not run the question.'} Neither the audits question nor the findings question returned rows carrying a pass score, so there is nothing to attribute to an auditor.`
        }
        onRetry={load}
      />
    )
  }

  const noAuditor = m.rows.length === 1 && m.rows[0].name === '(not stated)'
  const groupLabel = (GROUP_DIMS.find((d) => d.key === groupBy)?.label || 'group').toLowerCase()

  // Recharts wants one row per bar with a key per stacked band.
  // Whether the split actually has anything in it. Region is always offered
  // — it is the one an operator can fix — so it can legitimately be empty,
  // and saying so beats a chart of one band called '(not stated)'.
  const splitEmpty = !dimensionHasData(filtered, groupBy)

  const chartData = m.rows.slice(0, 20).map((r) => ({ name: r.name, ...r.groups }))
  const fetchedAt = audits?.fetchedAt ? new Date(audits.fetchedAt) : null

  return (
    <div className="animate-fade-in-up">
      {/* The same six controls as the other two tabs, in the same order and
          the same shape, so moving between them does not move the furniture.
          Granularity is absent here alone: this tab has no chart bucketed by
          period, so the control would do nothing, and an inert control is
          exactly what the rest of this tidy-up was removing. */}
      <div className="card mb-5 divide-y divide-surface-100 p-0">
        <FilterRow label="Period">
          <DateField
            id="aud-from" label="From" value={f.from} min={opts.minDate} max={f.to || opts.maxDate}
            onChange={(v) => setF({ ...f, from: v })}
          />
          <DateField
            id="aud-to" label="To" value={f.to} min={f.from || opts.minDate} max={opts.maxDate}
            onChange={(v) => setF({ ...f, to: v })}
          />
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <button
              type="button"
              onClick={() => setF(EMPTY)}
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
          </div>
        </FilterRow>

        <FilterRow label="Scope">
          <Picker id="aud-region" label="Region" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })}>
            <option value="all">All regions</option>
            {opts.regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </Picker>
          <Picker id="aud-entity" label="Entity" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>
            <option value="all">All entities</option>
            {opts.entities.map((r) => <option key={r} value={r}>{r}</option>)}
          </Picker>
          <Picker id="aud-type" label="Type of audit" value={f.auditType} onChange={(e) => setF({ ...f, auditType: e.target.value })}>
            <option value="all">All audit types</option>
            {opts.auditTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </Picker>
        </FilterRow>

        {dims.length > 1 && (
          <FilterRow label="Show">
            <Picker id="aud-group" label="Split by" value={groupBy} onChange={(e) => setF({ ...f, groupBy: e.target.value })}>
              {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </Picker>
          </FilterRow>
        )}
      </div>

      {/* No period, no figures — see hasRange above. */}
      {!hasRange && (
        <div className="card grid place-items-center px-6 py-16 text-center">
          <CalendarRange size={22} className="text-brand-600" />
          <p className="mt-3 text-[14px] font-semibold text-ink-800">Choose a period to run</p>
          <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-500">
            Set a From and To date above. The audits question covers the whole estate and takes up
            to a minute, so nothing is fetched until you say which window you want.
          </p>
        </div>
      )}

      {hasRange && noAuditor && (
        // Every audit landed in "(not stated)". That is a configuration answer,
        // not an empty chart, and it names the column to add.
        <p className="card mb-5 p-4 text-[12.5px] leading-relaxed text-ink-600">
          Your audits question returns no auditor column, so every audit below is pooled under
          “(not stated)”. Add the auditor’s name to the question — ODIN reads a column called
          <code className="mx-1 rounded bg-surface px-1.5 py-0.5 text-[11.5px]">Auditor</code>,
          <code className="mx-1 rounded bg-surface px-1.5 py-0.5 text-[11.5px]">Auditor_Name</code>,
          <code className="mx-1 rounded bg-surface px-1.5 py-0.5 text-[11.5px]">Inspector</code> or
          <code className="mx-1 rounded bg-surface px-1.5 py-0.5 text-[11.5px]">Audited_By</code>.
        </p>
      )}

      {hasRange && (<div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={UserCheck} label="Auditors" value={m.rows.length.toLocaleString()} sub="with at least one audit in scope" tone="#0d9488" />
        <Stat icon={ClipboardList} label="Audits conducted" value={m.total.toLocaleString()} tone="#2563eb" />
        <Stat
          icon={MapPin}
          label={`${plural(GROUP_DIMS.find((d) => d.key === groupBy)?.label || 'Groups')} covered`}
          value={m.columns.length.toLocaleString()}
          tone="#d97706"
        />
        <Stat
          icon={Radar}
          label="Audits per auditor"
          value={m.rows.length ? Math.round(m.total / m.rows.length).toLocaleString() : '—'}
          sub={busiestNote(m)}
          tone="#7c3aed"
        />
      </div>)}

      {/* Region is the split people want, so it is always the default and is
          never swapped out from under them. When the register has no regions
          the honest thing is to say which register to fill in — not to
          re-group the chart by something else and let it look answered. */}
      {hasRange && splitEmpty && m.total > 0 && (
        <p className="card mb-5 p-4 text-[12.5px] leading-relaxed text-ink-600">
          None of the audits in scope carry a <b>{groupLabel}</b>, so every bar below is pooled
          under “(not stated)”.
          {groupBy === 'region' || groupBy === 'entity' ? (
            <>
              {' '}This one comes from your own site register: set a {groupLabel} on each site in{' '}
              <b>Sites</b>, and give each site the warehouse’s <b>Centre ID</b> so its audits find
              it. Until then, pick another split above.
            </>
          ) : (
            <> Add the column to your Metabase question, or pick another split above.</>
          )}
        </p>
      )}

      {hasRange && (<>
      <Panel
        title={`Audits conducted by auditor, split by ${groupLabel}`}
        subtitle={m.rows.length > 20 ? 'Busiest 20; the full list is in the table below' : 'Busiest first'}
        className="mb-5"
      >
        {m.total === 0 ? (
          <NoData>No audits in this scope.</NoData>
        ) : (
          <ChartFrame
            label={`Audits by auditor and ${groupLabel}`}
            width="100%"
            height={Math.max(260, chartData.length * 34 + 70)}
          >
            <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 44, left: 8, bottom: 0 }}>
              <XAxis type="number" allowDecimals={false} {...axis} />
              <YAxis type="category" dataKey="name" width={150} {...axis} />
              <Tooltip cursor={{ fill: 'rgba(227,204,191,0.35)' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 10.5 }} />
              {m.columns.map((c, i) => (
                <Bar key={c} dataKey={c} name={c} stackId="g" fill={paletteColor(i)}>
                  {/* The total, once, at the end of the bar — not a number on
                      every band, which is unreadable at this density. */}
                  {i === m.columns.length - 1 && (
                    <LabelList
                      dataKey="name"
                      position="right"
                      content={({ x, y, height, index }) => (
                        <text x={x + 8} y={y + height / 2 + 4} fontSize={10.5} fill="#8a6844">
                          {m.rows[index]?.total}
                        </text>
                      )}
                    />
                  )}
                </Bar>
              ))}
            </BarChart>
          </ChartFrame>
        )}
      </Panel>

      <Panel
        title="Every auditor in scope"
        subtitle="Audits conducted, centres reached, and how the centres they visited scored"
      >
        {m.rows.length === 0 ? (
          <NoData height={160}>No audits in this scope.</NoData>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-[10.5px] uppercase tracking-wide text-ink-400">
                    <th className="py-2 pr-3 font-semibold">Auditor</th>
                    <th className="py-2 pr-3 text-right font-semibold">Audits</th>
                    <th className="py-2 pr-3 text-right font-semibold">Centres</th>
                    <th className="py-2 pr-3 text-right font-semibold">{GROUP_DIMS.find((d) => d.key === groupBy)?.label || 'Groups'}</th>
                    <th className="py-2 pr-3 font-semibold">Audit types</th>
                    <th className="py-2 text-right font-semibold">Pass rate of centres visited</th>
                  </tr>
                </thead>
                <tbody>
                  {m.rows.map((r) => (
                    <tr key={r.name} className="border-b border-ink-200/60 last:border-0">
                      <td className="py-2 pr-3 font-semibold text-ink-800">{r.name}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-700">{r.total.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-600">{r.sites.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink-600">{Object.keys(r.groups).length}</td>
                      <td className="py-2 pr-3 text-ink-500">{r.auditTypes.join(', ') || '—'}</td>
                      <td className="py-2 text-right tabular-nums">
                        {r.passRate == null ? (
                          <span className="text-ink-400">—</span>
                        ) : (
                          <span className={r.passRate >= PASS_MARK ? 'font-semibold text-emerald-600' : 'font-semibold text-red-600'}>
                            {r.passRate}%
                            <span className="ml-1 font-normal text-ink-400">({r.passed}/{r.scored})</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-[11.5px] leading-relaxed text-ink-500">
              <b>The last column is not a performance measure.</b> It is the pass rate of the centres
              that auditor was sent to, judged at the seven-day re-check where the question supplies
              one. An auditor assigned the worst centres in the estate will post the lowest number
              here, and it says nothing about how they audited.
            </p>
          </>
        )}
      </Panel>

      <p className="mt-4 text-[11.5px] leading-relaxed text-ink-400">
        From your Metabase audits question{fetchedAt ? `, as at ${fetchedAt.toLocaleString()}` : ''}.
        {audits?.range && <> Covering <strong className="font-semibold text-ink-600">{audits.range.from} to {audits.range.to}</strong>
          {!f.from && !f.to && ' — the default window, because the date boxes are empty'}.</>}
        {' '}A snapshot, not a live feed — press Refresh to run it again.
        {audits?.capped && (
          <> Showing the first {audits.rows.length.toLocaleString()} of {audits.total.toLocaleString()} rows.</>
        )}
        {cov.missing > 0 && (
          <> <strong className="font-semibold text-amber-800">{cov.missing.toLocaleString()} of {cov.total.toLocaleString()} audits
          carry no region</strong> — the audits question has no region column, so every region here comes from your
          site register by centre id.{' '}
          {cov.noSite > 0 && <>{cov.noSite.toLocaleString()} sit at centres the register does not hold. </>}
          {cov.noRegion > 0 && <>{cov.noRegion.toLocaleString()} sit at centres it holds with no region set. </>}
          They are counted in the totals but vanish when you pick a Region.</>
        )}
      </p>
      </>)}
    </div>
  )
}

/** "City" → "Cities". Enough English for the nine dimension names in GROUP_DIMS. */
const plural = (word) => (/y$/.test(word) ? `${word.slice(0, -1)}ies` : /s$/.test(word) ? word : `${word}s`)

/** "one auditor did a third of them" — the concentration worth noticing. */
function busiestNote(m) {
  if (m.rows.length < 2 || !m.total) return undefined
  const top = m.rows[0]
  const share = Math.round((top.total / m.total) * 100)
  return share >= 30 ? `${top.name} did ${share}% of them` : undefined
}

function Blocked({ title, body, onRetry }) {
  return (
    <div className="card grid place-items-center px-6 py-14 text-center">
      <h3 className="text-[15px] font-semibold text-ink-800">{title}</h3>
      <p className="mt-2 max-w-lg text-[12.5px] leading-relaxed text-ink-500">{body}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm"
        >
          <RefreshCw size={14} /> Try again
        </button>
      )}

    </div>
  )
}
