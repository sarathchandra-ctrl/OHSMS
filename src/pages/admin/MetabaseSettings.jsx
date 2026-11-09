// ─────────────────────────────────────────────────────────────────────────────
// Organization settings → Integrations → Metabase.
//
// The connection form itself is shared with the ODIN tab, which offers the same
// form inline when nothing is connected yet — see shared/integrations/
// MetabaseConnect.jsx for why it lives there rather than here.
//
// What this page adds is the reference: exactly which columns each question
// should return. It is PRINTED rather than buried in documentation because a
// question that returns the right data under a name ODIN does not recognise is
// the commonest way this ends up blank, and it is a thirty-second fix in
// Metabase once you can see the list.
// ─────────────────────────────────────────────────────────────────────────────
import { Database, ExternalLink } from 'lucide-react'
import { Card } from '../../shared/ui'
import MetabaseConnect from '../../shared/integrations/MetabaseConnect'

// Mirrors COLUMN_ALIASES in stack/lib/metabase.js. Kept as prose rather
// than imported: the server file is the authority on the matching, and this is
// the human-readable half — the aliases it accepts are broader than what is
// worth printing on a settings screen.
const FINDINGS_COLUMNS = [
  ['Site', 'site / site_name / centre_name — the site the finding was raised at'],
  ['Site ID', 'centre_service_id / site_code — the warehouse\u2019s own id. Matched against a site\u2019s Centre ID in Sites, which is a far better join than the name'],
  ['Status', 'status / ticket_status — Open, In Progress, On Hold, Closed (synonyms are matched)'],
  ['Audit date', 'audit_date / ticket_date / date — the day the finding was raised'],
  ['Closed date', 'closed_date / ticket_closed_time — optional, used for the N+7 closure view'],
  ['Sub-category', 'sub_category / L2_tag — the finding sub-category, charted as bars'],
  ['Category', 'category / L1_tag — optional, the parent grouping of the sub-category'],
  ['Checkpoint', 'checkpoint / question — the audit question behind the finding. Drives the most-failed-checkpoints league table, which is the list that says what to fix estate-wide'],
  ['Priority', 'priority / priority_flag / severity — drives the priority mix'],
  ['SLA', 'sla_status — anything containing \u201cbreach\u201d counts as breached'],
  ['TAT', 'tat_closure_hour — optional, hours taken to close'],
  ['Latitude / Longitude', 'optional. Without them a site is placed from your own site register instead'],
  ['Count', 'optional. Include it if the question is already grouped; otherwise one row = one finding'],
  ['Pass / Fail', 'optional. If your findings rows carry check counts, ODIN draws the pass percentages straight from them and no second question is needed'],
]

const AUDIT_COLUMNS = [
  ['Site, Site ID', 'the same two columns as the findings question'],
  ['Audit date', 'audit_date / start_date — the day of the audit'],
  ['Pass / Fail', 'pass and fail — how many checks passed and how many failed on the day. This is the preferred form: the counts carry the size of the audit'],
  ['Pass N+7 / Fail N+7', 'the same two counts at the seven-day re-check'],
  ['Pass %', 'pass_percentage / score / cas_score — use this instead if you only hold the percentage'],
  ['Pass % (N+7)', 'pass_percentage_n7 / cas_seven_day_score — the percentage at the seven-day re-check'],
  ['Pass % (to date)', 'cas_current_day_score — optional, every closure credited up to now. Shown as context, never trended: it is the one figure that moves between refreshes without the estate changing'],
  ['Audit type', 'type_of_audit / labels — which audit this was, and a filter on both tabs'],
  ['Auditor', 'auditor / auditor_name / inspector — required for the Auditors tab; without it every audit pools under \u201c(not stated)\u201d'],
  ['Checks total', 'optional. Supply it when some checks were neither passed nor failed; otherwise pass + fail is the total'],
]

// Offered on BOTH questions, and each becomes a filter and a "break down by"
// option wherever the data carries it. Region and entity are the two this
// app can fill in itself from the site register; the rest have to come from
// the warehouse.
const DIMENSION_COLUMNS = [
  ['Region', 'region / zone / area — filled from your site register when the question is silent'],
  ['Entity', 'entity / business_unit / company — likewise'],
  ['City', 'city / city_name'],
  ['Business line', 'business_line / brand / vertical'],
  ['Ownership', 'ownership_type / owned_by — who operates the site'],
  ['Centre type', 'center_type / format'],
]

export default function MetabaseSettings({ actor }) {
  return (
    <div className="max-w-2xl space-y-5">
      <MetabaseConnect actor={actor} />

      <Card>
        <h3 className="flex items-center gap-2 font-semibold text-ink-800">
          <Database size={17} className="text-brand-600" /> What each question should return
        </h3>
        <p className="mb-4 mt-1 text-sm text-ink-500">
          Column names are matched case-insensitively and ignore spaces and underscores, so
          <code> Site Name</code>, <code>site_name</code> and <code>SITENAME</code> are the same column.
          Anything ODIN does not recognise is listed on the ODIN tab rather than dropped silently.
        </p>

        <ColumnList title="Findings question (required)" rows={FINDINGS_COLUMNS} />
        <ColumnList title="Audits question (optional)" rows={AUDIT_COLUMNS} className="mt-5" />
        <ColumnList title="On either question — how the estate is cut" rows={DIMENSION_COLUMNS} className="mt-5" />

        {/* The one distinction that catches people out, said where they will be
            looking when it catches them. */}
        <p className="ring-1 ring-ink-200 mt-5 rounded-2xl bg-surface-50/60 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-600 ">
          <b>Pass</b> and <b>Pass %</b> are different columns. A bare <code>pass</code> beside a bare
          <code> fail</code> is read as a COUNT of checks; <code>pass %</code> is read as a percentage.
          Give ODIN the counts where you have them — they carry how big each audit was, which is what
          lets a region be weighted properly instead of averaging a four-point audit against a
          four-hundred-point one.
        </p>

        <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-ink-400">
          <ExternalLink size={13} className="mt-0.5 flex-none" />
          Each question is run with your API key&apos;s permissions, so it must be readable by the group
          that key belongs to. ODIN reads at most 20,000 rows per question and says so on the dashboard
          when a question returns more — group or filter in Metabase to stay under it.
        </p>
      </Card>
    </div>
  )
}

function ColumnList({ title, rows, className = '' }) {
  return (
    <div className={className}>
      <p className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-400">{title}</p>
      <dl className="space-y-1.5">
        {rows.map(([name, desc]) => (
          <div key={name} className="ring-1 ring-ink-200 flex flex-wrap gap-x-2 rounded-xl bg-surface-50/60 px-3 py-2 ">
            <dt className="text-[12.5px] font-bold text-ink-800">{name}</dt>
            <dd className="text-[12px] text-ink-500">{desc}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
