import { useMemo, useState } from 'react'
import { Target, Building2, MapPin, Landmark, TrendingUp, TrendingDown, Info, ChevronDown, ChevronUp } from 'lucide-react'
import { PageHeader, Card, Select, Badge, EmptyState, SkeletonCard, StatCard } from '../../../shared/ui'
import IncompleteNotice from '../../../shared/ui/IncompleteNotice'
import { useObjectives } from '../context/ObjectivesContext'
import { LEVELS, buildScorecard, breakdown, RAG } from '../lib/kpis'

/** Actual vs target bar. Count KPIs (incidents) render as a plain figure. */
function Gauge({ row }) {
  const { kpi, value, target, rag } = row
  if (value == null) return <span className="text-sm italic text-ink-400">No data</span>
  if (kpi.unit !== '%') {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-black" style={{ color: rag.color }}>{value}</span>
        {target != null && <span className="text-xs text-ink-400">target ≤ {target}</span>}
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-black" style={{ color: rag.color }}>{value}%</span>
        {target != null && <span className="text-xs text-ink-400">target {target}%</span>}
      </div>
      <div className="relative mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-surface-200">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, value)}%`, backgroundColor: rag.color }} />
        {target != null && (
          <div className="absolute top-0 h-full w-0.5 bg-ink-700" style={{ left: `${Math.min(100, target)}%` }} title={`Target ${target}%`} />
        )}
      </div>
    </div>
  )
}

export default function Scorecard() {
  const { loading, objectives, data, incomplete, entities, regionScopes, siteScopes } = useObjectives()
  const [level, setLevel] = useState('org')
  const [scope, setScope] = useState('')
  const [entity, setEntity] = useState('all')
  const [openKpi, setOpenKpi] = useState(null)

  const scopeOptions = level === 'region' ? regionScopes : level === 'site' ? siteScopes : []
  const activeScope = level === 'org' ? '' : (scope || scopeOptions[0]?.value || '')
  const scopeLabel = level === 'org'
    ? 'Organization'
    : scopeOptions.find((s) => s.value === activeScope)?.label || '—'

  const rows = useMemo(
    () => buildScorecard(data, objectives, level, activeScope, entity),
    [data, objectives, level, activeScope, entity]
  )

  const summary = useMemo(() => {
    const counted = rows.filter((r) => r.rag.key !== 'no_data')
    return {
      tracked: counted.length,
      onTrack: counted.filter((r) => r.rag.key === 'on_track').length,
      atRisk: counted.filter((r) => r.rag.key === 'at_risk').length,
      offTrack: counted.filter((r) => r.rag.key === 'off_track').length,
    }
  }, [rows])

  if (loading) {
    return (
      <>
        <PageHeader title="Objectives & Targets" subtitle="KPI performance against target" icon={Target} />
        <SkeletonCard className="max-w-3xl" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Objectives & Targets"
        subtitle="OH&S KPI performance against target — organization, region and site"
        icon={Target}
        actions={
          <div className="flex flex-wrap gap-2">
            <Select className="!w-auto" value={level} onChange={(e) => { setLevel(e.target.value); setScope('') }}>
              {LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label} level</option>)}
            </Select>
            {level !== 'org' && (
              <Select className="!w-auto" value={activeScope} onChange={(e) => setScope(e.target.value)}>
                {scopeOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            )}
            {level !== 'site' && entities.length > 0 && (
              <Select className="!w-auto" value={entity} onChange={(e) => setEntity(e.target.value)} title="Filter by entity">
                <option value="all">All entities</option>
                {entities.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            )}
          </div>
        }
      />

      {/* Above the figures, not below them: a KPI is read and then quoted, and
          a caveat underneath arrives after the decision has been made. */}
      <IncompleteNotice incomplete={incomplete} className="mb-5" />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="KPIs tracked" value={summary.tracked} icon={Target} tone="brand" />
        <StatCard label="On target" value={summary.onTrack} icon={TrendingUp} tone="green" />
        <StatCard label="At risk" value={summary.atRisk} icon={Info} tone="amber" />
        <StatCard label="Off target" value={summary.offTrack} icon={TrendingDown} tone="red" />
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm text-ink-500">
        {level === 'org' ? <Building2 size={15} /> : level === 'region' ? <MapPin size={15} /> : <Landmark size={15} />}
        Showing <b className="text-ink-800">{scopeLabel}</b>
        {entity !== 'all' && <>· entity <b className="text-ink-800">{entity}</b></>}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Target} title="No KPIs at this level" description="Pick another level to see its KPIs." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const canDrill = level !== 'site' && row.kpi.levels.includes(level === 'org' ? 'region' : 'site')
            const isOpen = openKpi === row.kpi.key
            const drillLevel = level === 'org' ? 'region' : 'site'
            const drillScopes = drillLevel === 'region'
              ? regionScopes
              : siteScopes.filter((s) => level === 'region' ? s.region === activeScope : true)
            const drillRows = isOpen ? breakdown(data, objectives, row.kpi.key, drillLevel, drillScopes, entity) : []
            return (
              <Card key={row.kpi.key} className="flex flex-col !p-5">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold leading-snug text-ink-900">{row.kpi.label}</p>
                    <p className="text-xs text-ink-400">from {row.kpi.source}</p>
                  </div>
                  <Badge tone={row.rag.tone}>{row.rag.label}</Badge>
                </div>

                <Gauge row={row} />

                <p className="mt-2 text-xs text-ink-400">
                  {row.kpi.unit === '%'
                    ? `${row.numerator} of ${row.denominator}`
                    : `${row.numerator} recorded`}
                  {row.target == null && ' · no target set'}
                  {row.period !== 'now' && ` · ${row.period}`}
                </p>
                <p className="mt-1 text-xs italic text-ink-400">{row.kpi.help}</p>

                {canDrill && (
                  <>
                    <button
                      className="btn-ghost mt-3 justify-center px-2.5 py-1.5 text-xs"
                      onClick={() => setOpenKpi(isOpen ? null : row.kpi.key)}
                    >
                      {isOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      {isOpen ? 'Hide' : `By ${drillLevel}`}
                    </button>
                    {isOpen && (
                      <div className="mt-2 max-h-56 space-y-1 overflow-y-auto border-t border-surface-200/60 pt-2">
                        {drillRows.length === 0 && <p className="text-xs italic text-ink-400">Nothing to break down.</p>}
                        {drillRows.map((d) => (
                          <div key={d.value} className="flex items-center gap-2 text-xs">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.rag.color }} />
                            <span className="min-w-0 flex-1 truncate text-ink-700">{d.label}</span>
                            <span className="font-bold" style={{ color: d.rag.color }}>
                              {d.value == null ? '—' : `${d.value}${row.kpi.unit}`}
                            </span>
                            {d.target != null && <span className="text-ink-400">/ {d.target}{row.kpi.unit}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {/* Legend */}
      <Card className="mt-5 !py-3">
        <div className="flex flex-wrap items-center gap-4 text-xs text-ink-500">
          <span className="font-semibold uppercase tracking-wide">RAG</span>
          {[RAG.on_track, RAG.at_risk, RAG.off_track, RAG.no_data].map((r) => (
            <span key={r.key} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.color }} /> {r.label}
            </span>
          ))}
          <span className="ml-auto">Actuals are computed live from each module — only targets are entered.</span>
        </div>
      </Card>
    </>
  )
}
