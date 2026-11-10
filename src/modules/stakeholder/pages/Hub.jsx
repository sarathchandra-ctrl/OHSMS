import { Link } from 'react-router-dom'
import { MessageSquareWarning, Gavel, ArrowRight, Scale } from 'lucide-react'
import { PageHeader, SkeletonTable, EmptyState, ModuleMark } from '../../../shared/ui'
import { useStakeholder } from '../context/StakeholderContext'
import { NOTICE_BY_KEY } from '../lib/constants'

/**
 * Two tiles, one per sub-app, in the same shape as the portal home.
 *
 * Each carries the number that decides whether you need to open it. A tile
 * showing only a total is a link with decoration — what matters on the
 * escalations side is how many complaints stopped being complaints, and on the
 * legal side how many notices have a clock running on them.
 */
const TILES = [
  {
    to: '/stakeholder/escalations',
    label: 'Customer Escalations',
    icon: MessageSquareWarning,
    // Warm red: a complaint is a relationship problem.
    tone: 'red',
    blurb: 'Complaints raised by members, who was involved, and what was finally done about them.',
  },
  {
    to: '/stakeholder/legal',
    label: 'Legal Issues',
    icon: Gavel,
    // Amber: an authority turning up is an exposure, not yet a failure.
    tone: 'amber',
    blurb: 'Departments that visited, what they served, and the response owed on each.',
  },
]

const Metric = ({ value, label, tone = 'ink' }) => (
  <div className="min-w-0">
    <div
      className={`text-xl font-bold ${tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-ink-900'}`}
    >
      {value}
    </div>
    <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-ink-400">
      {label}
    </div>
  </div>
)

export default function Hub() {
  const { summary, escalations, legalIssues, loading, error } = useStakeholder()

  if (error) {
    return (
      <>
        <PageHeader title="Stakeholder Issues" icon={Scale} />
        <EmptyState
          icon={Scale}
          title="Could not load"
          hint="This is empty because it failed to load, not because nothing is recorded. Refresh and try again."
        />
      </>
    )
  }

  if (loading)
    return (
      <>
        <PageHeader title="Stakeholder Issues" icon={Scale} />
        <SkeletonTable rows={4} />
      </>
    )

  const openSevere = legalIssues.filter(
    (l) => l.status !== 'closed' && NOTICE_BY_KEY[l.noticeType]?.severe
  ).length

  const metrics = {
    '/stakeholder/escalations': [
      { value: summary.escalations.open, label: 'Open' },
      // The one a total cannot show: complaints that reached an authority.
      {
        value: summary.escalations.escalatedToLegal,
        label: 'Became legal',
        tone: summary.escalations.escalatedToLegal ? 'amber' : 'ink',
      },
      { value: summary.escalations.total, label: 'All time' },
    ],
    '/stakeholder/legal': [
      { value: summary.legal.open, label: 'Open' },
      { value: openSevere, label: 'Serious', tone: openSevere ? 'red' : 'ink' },
      { value: summary.legal.total, label: 'All time' },
    ],
  }

  return (
    <>
      <PageHeader
        title="Stakeholder Issues"
        icon={Scale}
        subtitle={`${escalations.length} escalations · ${legalIssues.length} legal issues`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {TILES.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="group card flex flex-col gap-4 p-5 transition hover:-translate-y-0.5 hover:shadow-elev-lg"
          >
            <div className="flex items-start gap-3">
              <ModuleMark tone={t.tone} size="md">
                <t.icon size={22} />
              </ModuleMark>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 font-bold text-ink-900">
                  {t.label}
                  <ArrowRight
                    size={15}
                    className="text-ink-300 transition group-hover:translate-x-0.5 group-hover:text-ink-500"
                  />
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{t.blurb}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 border-t border-ink-100 pt-3">
              {metrics[t.to].map((m) => (
                <Metric key={m.label} {...m} />
              ))}
            </div>
          </Link>
        ))}
      </div>

      {/* Said once here rather than on both tiles: the crossover is the reason
          these two sit in one module at all. */}
      {summary.escalations.escalatedToLegal > 0 && (
        <p className="mt-4 text-xs text-ink-500">
          <b>{summary.escalations.escalatedToLegal}</b> customer complaint
          {summary.escalations.escalatedToLegal === 1 ? ' has' : 's have'} become a legal matter.
          Those appear in both places — the escalation carries the notice served against it.
        </p>
      )}
    </>
  )
}
