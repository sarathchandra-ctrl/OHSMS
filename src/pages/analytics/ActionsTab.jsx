// ─────────────────────────────────────────────────────────────────────────────
// Actions analytics.
//
// The Action Tracker already merges CAPA from nine modules into one normalized
// list; this tab asks the questions the table cannot answer at a glance — how
// much has slipped, how far, whose it is, and which module keeps generating it.
// It subscribes through the tracker's own aggregation so the two can never
// disagree about what an action is.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable react-refresh/only-export-components --
   the aggregation is exported for ActionsTab.test.js, not for other components
   to import; splitting it out would put the tab's own logic in a shared file. */
import { useEffect, useMemo, useState } from 'react'
import { CircleDot, Loader2, CheckCircle2, CalendarX } from 'lucide-react'
import { Panel, Stat, NoData, Picker } from './ui'
import Breakdown from './Breakdown'
import { monthOf } from './moduleAnalytics'
import { SOURCES, SOURCE_BY_KEY, subscribeActions, todayISO } from '../../modules/actions/lib/sources'
import IncompleteNotice from '../../shared/ui/IncompleteNotice'

const DAY = 86400000

/**
 * A 'YYYY-MM-DD' day as a UTC timestamp, or null when it is not a real date.
 *
 * Everything here compares dates, not strings: an unpadded or impossible date
 * sorts perfectly happily as text ('2026-9-1' reads as later than '2026-12-01')
 * and would quietly land on the wrong side of overdue.
 */
export function parseDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(ts)
  // Date.UTC rolls 31 February forward into March rather than rejecting it.
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ts : null
}

/** Whole days a due date is past `today`; negative if future, null if undated. */
export function daysOverdue(due, today = todayISO()) {
  const d = parseDay(due)
  const t = parseDay(today)
  if (d === null || t === null) return null
  return Math.round((t - d) / DAY)
}

/** An action is overdue only if it is unfinished AND has a due date now past. */
export function isActionOverdue(action, today = todayISO()) {
  if (!action || action.norm === 'done') return false
  const days = daysOverdue(action.due, today)
  return days !== null && days > 0
}

/**
 * The 'YYYY-MM' a due date falls in; '' when there is no usable date.
 *
 * Stricter than monthOf on its own, deliberately. This tab already treats a due
 * date it cannot parse as no due date at all, so '2026-02-31' must not read as
 * February for the range while reading as undated everywhere else — one action
 * cannot be both dated and undated on the same screen.
 */
export function dueMonth(due) {
  return parseDay(due) === null ? '' : monthOf(due)
}

// Worst first: this list is read to decide what to chase, and the oldest slip
// is the one that has been chased least.
export const AGE_BANDS = [
  { key: 'over90', name: 'Overdue 90+ days', color: '#b91c1c', holds: (d) => d > 90 },
  { key: 'over31', name: 'Overdue 31–90 days', color: '#ef4444', holds: (d) => d > 30 },
  { key: 'over8', name: 'Overdue 8–30 days', color: '#f97316', holds: (d) => d > 7 },
  { key: 'over1', name: 'Overdue 1–7 days', color: '#f59e0b', holds: (d) => d > 0 },
  { key: 'today', name: 'Due today', color: '#eab308', holds: (d) => d === 0 },
  { key: 'later', name: 'Not yet due', color: '#22c55e', holds: (d) => d < 0 },
  { key: 'nodue', name: 'No due date', color: '#94a3b8', holds: (d) => d === null },
]

export function ageBand(days) {
  return AGE_BANDS.find((b) => b.holds(days)).key
}

const NO_OWNER = 'Unassigned'

/**
 * Everything the tab shows, from the tracker's flat action list.
 *
 * Scoping mirrors the rest of analytics: an action inherits its site from the
 * record that raised it, one that resolves to a site the viewer cannot see is
 * not theirs to count, and one that resolves to no site at all is only shown to
 * viewers who can see every site.
 *
 * `from` / `to` are inclusive 'YYYY-MM' bounds on the due date; '' means no
 * bound at that end. Overdue is untouched by them — it is still measured against
 * `today`, so narrowing to a past month cannot turn future work overdue, and
 * every ageing figure is still read off the same in-scope unfinished list.
 */
export function actionAnalytics(rows = [], sites = [], opts = {}) {
  const { siteId = 'all', source = 'all', from = '', to = '', keepUnplaced = true, today = todayISO() } = opts
  const visible = new Set((sites || []).map((s) => s.id))

  const universe = (rows || []).filter(
    (r) => r && (visible.has(r.siteId) || (keepUnplaced && !r.siteId)),
  )
  // An undated action survives a range rather than vanishing, the same rule the
  // other tabs follow. It matters more here than anywhere: whole modules —
  // inspections, extinguisher defects — raise actions with no due date at all,
  // and dropping them would let a range hide the work nobody has scheduled.
  const inRange = (r) => {
    const m = dueMonth(r.due)
    if (!m) return true
    return (!from || m >= from) && (!to || m <= to)
  }
  const list = universe.filter(
    (r) => (source === 'all' || r.source === source)
      && (siteId === 'all' || r.siteId === siteId)
      && inRange(r),
  )

  const open = list.filter((r) => r.norm === 'open')
  const inProgress = list.filter((r) => r.norm === 'in_progress')
  const done = list.filter((r) => r.norm === 'done')
  const unfinished = list.filter((r) => r.norm !== 'done')

  // Days are computed once per unfinished action; every ageing figure below is
  // read off this so overdue and the ageing bands can never drift apart.
  const aged = unfinished.map((r) => ({ row: r, days: daysOverdue(r.due, today) }))
  const overdue = aged.filter((a) => a.days !== null && a.days > 0)

  const bandCount = new Map()
  for (const a of aged) {
    const band = ageBand(a.days)
    bandCount.set(band, (bandCount.get(band) || 0) + 1)
  }

  const overdueBySource = new Map()
  for (const a of overdue) overdueBySource.set(a.row.source, (overdueBySource.get(a.row.source) || 0) + 1)

  const owners = new Map()
  for (const r of unfinished) {
    const name = String(r.owner || '').trim() || NO_OWNER
    const cur = owners.get(name) || { key: name, name, value: 0, open: 0, inProgress: 0, overdue: 0 }
    cur.value += 1
    if (r.norm === 'open') cur.open += 1
    else cur.inProgress += 1
    if (isActionOverdue(r, today)) cur.overdue += 1
    owners.set(name, cur)
  }

  const worstSourceKey = [...overdueBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''

  return {
    shown: list.length,
    universeTotal: universe.length,
    // What the pickers are hiding, so a narrowed total never reads as the whole.
    narrowed: universe.length - list.length,
    unplaced: list.filter((r) => !r.siteId).length,
    // Offered from everything the viewer can see rather than from the filtered
    // set: a month that disappears once you pick it leaves no way back.
    months: [...new Set(universe.map((r) => dueMonth(r.due)).filter(Boolean))].sort(),
    open: open.length,
    inProgress: inProgress.length,
    done: done.length,
    unfinished: unfinished.length,
    overdue: overdue.length,
    // Overdue and still not picked up is a different conversation from overdue
    // and half-finished, so the two are never merged into one figure.
    overdueNotStarted: overdue.filter((a) => a.row.norm === 'open').length,
    noDue: aged.filter((a) => a.days === null).length,
    // Every undated action in scope, finished or not. noDue is the unfinished
    // part of it; this is the part a month range cannot place, so it is what
    // explains why `shown` still holds records outside the months picked.
    undated: list.filter((r) => !dueMonth(r.due)).length,
    worstOverdueDays: overdue.reduce((n, a) => Math.max(n, a.days), 0),
    worstSource: worstSourceKey ? SOURCE_BY_KEY[worstSourceKey]?.label || worstSourceKey : '',
    worstSourceCount: worstSourceKey ? overdueBySource.get(worstSourceKey) : 0,
    ageing: AGE_BANDS.map((b) => ({ key: b.key, name: b.name, value: bandCount.get(b.key) || 0, color: b.color }))
      .filter((b) => b.value > 0),
    bySource: SOURCES.map((s) => {
      const mine = list.filter((r) => r.source === s.key)
      return {
        key: s.key,
        name: s.label,
        color: s.tone,
        value: mine.filter((r) => r.norm !== 'done').length,
        total: mine.length,
        overdue: mine.filter((r) => isActionOverdue(r, today)).length,
      }
    })
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)),
    byOwner: [...owners.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)),
  }
}

const OWNER_LIMIT = 8
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The one sentence the tab uses to account for actions with no due date.
 *
 * They need saying for two reasons — they can never become overdue, and no month
 * range can place them, so they stay in the count whichever months are picked —
 * and telling the reader that twice, in two places, with two different numbers,
 * is how they end up believing there are two separate piles of undated work.
 * So it is said once, next to the overdue figure it qualifies.
 */
export function undatedNote({ undated = 0, noDue = 0 } = {}, rangeActive = false) {
  // Nothing to account for: no undated work, or none of it is unfinished and no
  // range is prompting the question of why undated rows are still counted.
  if (undated === 0 || (noDue === 0 && !rangeActive)) return ''

  const one = undated === 1
  const carry = one ? 'carries' : 'carry'
  const parts = []
  if (noDue === 0) {
    parts.push(`${plural(undated, 'action')} in scope ${carry} no due date, and ${one ? 'it is' : 'all of them are'} already done.`)
  } else if (noDue === undated) {
    parts.push(`${plural(noDue, 'unfinished action')} ${carry} no due date and can never appear above.`)
  } else {
    parts.push(`${plural(undated, 'action')} in scope ${carry} no due date, ${noDue} of them unfinished and so unable to appear above.`)
  }

  if (rangeActive) {
    parts.push(`A month range cannot place an undated action either, so ${one ? 'it stays' : 'they all stay'} counted whichever months you pick.`)
  }
  if (noDue > 0) {
    const which = noDue < undated ? 'the unfinished ones' : (one ? 'it' : 'them')
    parts.push(`Set a due date in the source module to bring ${which} into this figure.`)
  }
  return parts.join(' ')
}

export default function ActionsTab({ sites = [], keepUnplaced = true }) {
  const [rows, setRows] = useState(null)
  const [incomplete, setIncomplete] = useState(null)
  const [siteId, setSiteId] = useState('all')
  const [source, setSource] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const today = todayISO()

  useEffect(() => {
    return subscribeActions(({ rows, incomplete }) => { setRows(rows); setIncomplete(incomplete) })
  }, [])

  const a = useMemo(
    () => actionAnalytics(rows || [], sites, { siteId, source, from, to, keepUnplaced, today }),
    [rows, sites, siteId, source, from, to, keepUnplaced, today],
  )

  const owners = a.byOwner.slice(0, OWNER_LIMIT)
  const rangeActive = from !== '' || to !== ''
  const undated = undatedNote(a, rangeActive)

  if (rows === null) {
    return <NoData height={280}>Collecting actions from every module…</NoData>
  }

  if (a.universeTotal === 0) {
    return (
      <div className="card px-6 py-14 text-center">
        <p className="text-[15px] font-bold text-ink-900">
          {rows.length === 0 ? 'No actions have been raised yet' : 'No actions for the sites you can see'}
        </p>
        <p className="mx-auto mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-ink-500">
          {rows.length === 0
            ? 'CAPA raised on an incident, a failed inspection check, an audit finding, a drill or a committee action collects here. Raise one in its module and it will appear.'
            : 'Actions inherit their site from the record that raised them. Ask an admin for access to another site, or set a site on the records you already own.'}
        </p>
      </div>
    )
  }

  return (
    <div className="animate-fade-in-up">
      <IncompleteNotice incomplete={incomplete} className="mb-5" />
      <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <Picker id="ac-site" label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          <option value="all">All sites ({sites.length})</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Picker>
        <Picker id="ac-source" label="Raised in" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">All modules</option>
          {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Picker>
        {/* Labelled "Due" because an action carries no other date — without it
            the pair reads as when the action was raised, which is not a thing
            the tracker records. */}
        <Picker id="ac-from" label="Due from" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Earliest</option>
          {a.months.map((m) => <option key={m} value={m}>{m}</option>)}
        </Picker>
        <Picker id="ac-to" label="Due to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Latest</option>
          {a.months.map((m) => <option key={m} value={m}>{m}</option>)}
        </Picker>
        <button
          type="button"
          onClick={() => { setSiteId('all'); setSource('all'); setFrom(''); setTo('') }}
          className="rounded-2xl bg-surface px-4 py-2.5 text-[12.5px] font-semibold text-ink-700 shadow-elev-sm"
        >
          Reset
        </button>
        {a.narrowed > 0 && (
          <p className="basis-full text-[11.5px] text-ink-400">
            Every figure below counts the {a.shown} action{a.shown === 1 ? '' : 's'} that match these
            filters, not all {a.universeTotal} you can see.
          </p>
        )}
      </div>

      {/* The one number people act on, so it gets its own panel rather than a
          quarter of a stat row — and it counts only unfinished work. */}
      <Panel
        title="Overdue"
        subtitle={
          rangeActive
            ? 'Past their due date as of today, and not yet done — the range narrows which actions are counted, never what overdue means'
            : 'Past their due date and not yet done'
        }
        className="mb-3"
      >
        <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
          <div>
            <p
              className="text-[52px] font-extrabold leading-none tracking-[-0.04em]"
              style={{ color: a.overdue ? '#dc2626' : '#16a34a' }}
            >
              {a.overdue}
            </p>
            <p className="mt-2 text-[12.5px] font-semibold text-ink-700">
              {a.overdue === 0
                ? `Nothing has slipped — ${plural(a.unfinished, 'action')} still to close`
                : `of ${plural(a.unfinished, 'unfinished action')}`}
            </p>
          </div>
          <dl className="grid gap-2 text-[12px]">
            <div className="flex gap-2">
              <dt className="w-[124px] text-ink-400">Longest overdue</dt>
              <dd className="font-semibold text-ink-900">
                {a.overdue === 0 ? '—' : plural(a.worstOverdueDays, 'day')}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[124px] text-ink-400">Worst module</dt>
              <dd className="font-semibold text-ink-900">
                {a.worstSource ? `${a.worstSource} (${a.worstSourceCount})` : '—'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[124px] text-ink-400">Not started</dt>
              <dd className="font-semibold text-ink-900">
                {a.overdue === 0 ? '—' : plural(a.overdueNotStarted, 'action')}
              </dd>
            </div>
          </dl>
        </div>
        {undated !== '' && (
          /* Undated work can never become overdue, so a low overdue count is
             only reassuring once you know how much is missing a date — and once
             a range is set, the same actions are also the ones it cannot place. */
          <p className="mt-4 text-[11.5px] text-ink-400">{undated}</p>
        )}
      </Panel>

      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={CircleDot} label="Open" value={a.open} sub="not started" tone="#ef4444" />
        <Stat icon={Loader2} label="In progress" value={a.inProgress} sub="being worked" tone="#f59e0b" />
        <Stat icon={CheckCircle2} label="Done" value={a.done} sub={`of ${a.shown} in scope`} tone="#22c55e" />
        <Stat icon={CalendarX} label="No due date" value={a.noDue} sub="unfinished, undated" tone="#64748b" />
      </div>

      {a.unplaced > 0 && (
        <p className="mb-5 text-[11.5px] text-ink-400">
          {plural(a.unplaced, 'action')} come from records with no site set, so the site filter cannot
          reach them. They are included in every figure while “All sites” is selected.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="Ageing"
          subtitle="Unfinished actions by how far past due they are"
          rows={a.ageing}
        />
        <Breakdown
          title="Raised in"
          subtitle="Still to close, by module — completed actions are not counted"
          rows={a.bySource}
        />
        <Breakdown
          title="Owners"
          subtitle={
            a.byOwner.length > OWNER_LIMIT
              ? `The ${OWNER_LIMIT} carrying the most, of ${a.byOwner.length} owners`
              : 'Open and in progress actions they are carrying'
          }
          rows={owners}
          color="#7c3aed"
        />
      </div>
    </div>
  )
}
