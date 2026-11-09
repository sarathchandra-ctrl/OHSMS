import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts'
import ChartFrame from '../shared/ui/ChartFrame'
import {
  AlertTriangle,
  ShieldAlert,
  FileCheck,
  GraduationCap,
  ArrowRight,
  Activity,
} from 'lucide-react'
import { useAuth } from '../shared/auth/AuthContext'
import { createModuleService } from '../shared/module-kit/service'
import { dataProvider } from '../shared/data'
import { subscribeAuditLogs } from '../shared/org/orgData'
import { enabledModules } from '../shared/modules/entitlements'
import { auditLabel } from '../shared/audit/audit'
import { riskLists } from '../modules/hira/lib/raStats'
import { StatCard, Card, PageHeader, SkeletonStat, Skeleton, Badge, ModuleMark } from '../shared/ui'
import { fromNow } from '../shared/lib/format'

// Only the two collections whose documents are actually needed are streamed:
// incidents feeds the severity chart, and a risk band is derived per hazard at
// read time rather than stored, so the assessments have to be here to be
// counted. Permits and certificates are pure tallies and go through the
// server-side aggregate instead of downloading a thousand documents to call
// .length on them.
const incidentsSvc = createModuleService('incidents')
const assessmentsSvc = createModuleService('assessments', 'hira')

// Permits do not have an 'active' status — the vocabulary is draft / pending /
// approved / rejected / extended / closed — so a permit counts as live when it
// is approved, or approved and since extended.
const LIVE_PERMIT_STATUS = ['approved', 'extended']

// A record that never expires stores expiresOn: ''. The lower bound drops those
// without also dropping genuinely overdue certificates, which must still count.
const NEVER_EXPIRES = '1970-01-01'

function isoInDays(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export default function Dashboard() {
  const { profile, moduleMap } = useAuth()
  const modules = useMemo(() => enabledModules(moduleMap), [moduleMap])
  const [incidents, setIncidents] = useState(null)
  const [risks, setRisks] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [tallies, setTallies] = useState(null)
  const [logs, setLogs] = useState(null)

  useEffect(() => {
    const unsubs = [
      incidentsSvc.subscribe(setIncidents, () =>
        setLoadError('Incidents could not be loaded. This is not an empty list.')
      ),
      assessmentsSvc.subscribe(setRisks, () =>
        setLoadError('Assessments could not be loaded. This is not an empty list.')
      ),
      subscribeAuditLogs(setLogs, 8),
    ]
    return () => unsubs.forEach((u) => u && u())
  }, [])

  useEffect(() => {
    let live = true
    const cutoff = isoInDays(30)
    Promise.all([
      dataProvider.count(`permits`, {
        where: [{ field: 'status', op: 'in', value: LIVE_PERMIT_STATUS }],
      }),
      dataProvider.count(`trainingRecords`, {
        where: [
          { field: 'expiresOn', op: '>=', value: NEVER_EXPIRES },
          { field: 'expiresOn', op: '<=', value: cutoff },
        ],
      }),
    ])
      .then(([activePermits, expiringCerts]) => {
        if (live) setTallies({ activePermits, expiringCerts })
      })
      // A refused or failed aggregate must not read as "zero of them" on a
      // safety dashboard — show the tile as unavailable instead.
      .catch(() => live && setTallies({ activePermits: null, expiringCerts: null }))
    return () => {
      live = false
    }
  }, [])

  const loading = !loadError && (incidents === null || risks === null || tallies === null)

  const kpis = useMemo(() => {
    const openIncidents = (incidents || []).filter((i) => i.status && i.status !== 'closed').length
    // A band is a property of a hazard, not of the assessment that contains it.
    const { high, critical } = riskLists(risks || [])
    return {
      openIncidents,
      highRisks: high.length + critical.length,
      activePermits: tallies?.activePermits,
      expiringCerts: tallies?.expiringCerts,
    }
  }, [incidents, risks, tallies])

  const severityData = useMemo(() => {
    const buckets = { Low: 0, Medium: 0, High: 0, Critical: 0 }
    ;(incidents || []).forEach((i) => {
      if (buckets[i.severity] != null) buckets[i.severity]++
    })
    return Object.entries(buckets).map(([name, value]) => ({ name, value }))
  }, [incidents])
  const SEV_COLOR = { Low: '#94a3b8', Medium: '#f59e0b', High: '#ef4444', Critical: '#b91c1c' }

  return (
    <>
      <PageHeader
        title={`Welcome${profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}`}
        subtitle="Your organization's health & safety at a glance"
        icon={Activity}
      />
      {loadError && (
        <p role="alert" className="text-sm font-medium text-red-400">
          {loadError}
        </p>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading ? (
          <>
            <SkeletonStat />
            <SkeletonStat />
            <SkeletonStat />
            <SkeletonStat />
          </>
        ) : (
          <>
            <StatCard
              label="Open incidents"
              value={kpis.openIncidents}
              icon={AlertTriangle}
              tone="red"
              hint="Not yet closed"
            />
            <StatCard
              label="High / critical risks"
              value={kpis.highRisks}
              icon={ShieldAlert}
              tone="amber"
              hint="Residual band"
            />
            <StatCard
              label="Active permits"
              value={kpis.activePermits ?? '—'}
              icon={FileCheck}
              tone="green"
              hint="Approved or extended"
            />
            <StatCard
              label="Certs expiring ≤30d"
              value={kpis.expiringCerts ?? '—'}
              icon={GraduationCap}
              tone="brand"
              hint="Includes overdue"
            />
          </>
        )}
      </div>

      {/* Chart + recent activity */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h3 className="mb-4 font-semibold text-ink-800">Incidents by severity</h3>
          {loading ? (
            <Skeleton className="h-56 w-full" />
          ) : (incidents || []).length === 0 ? (
            <div className="grid h-56 place-items-center text-sm text-ink-400">
              No incidents recorded yet
            </div>
          ) : (
            <div className="h-56">
              <ChartFrame label="Incidents by severity" width="100%" height="100%">
                <BarChart data={severityData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                    contentStyle={{
                      borderRadius: 16,
                      border: 'none',
                      boxShadow: '0 8px 24px rgba(16,24,40,0.14)',
                    }}
                  />
                  <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                    {severityData.map((d) => (
                      <Cell key={d.name} fill={SEV_COLOR[d.name]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartFrame>
            </div>
          )}
        </Card>

        <Card>
          <h3 className="mb-4 font-semibold text-ink-800">Recent activity</h3>
          {logs === null ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-xl" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : logs.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">No activity yet</p>
          ) : (
            <ul className="space-y-3">
              {logs.map((l) => (
                <li key={l.id} className="flex items-start gap-3">
                  <span className="mt-0.5">
                    <ModuleMark tone="slate" size="sm" className="h-8 w-8 rounded-xl">
                      <Activity size={14} />
                    </ModuleMark>
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink-700">
                      <span className="font-medium">{l.actorName}</span> · {auditLabel(l.action)}
                      {l.targetLabel ? ` "${l.targetLabel}"` : ''}
                    </p>
                    <p className="text-xs text-ink-400">{fromNow(l.at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Module grid */}
      <h3 className="mb-3 mt-8 font-semibold text-ink-800">Modules</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {modules.map((m, i) => (
          <Link
            key={m.key}
            to={m.path}
            data-tone={m.tone}
            className="group glass-tile relative flex min-h-[168px] animate-fade-in-up flex-col items-center justify-center gap-3 p-5 text-center transition-transform duration-200 ease-emil hover:-translate-y-0.5 active:scale-[0.99]"
            style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
          >
            <span aria-hidden="true" className="glass-tile-glow" data-tone={m.tone} />
            {m.isNew && (
              <span className="absolute right-3 top-3 z-[2]">
                <Badge tone="brand">New</Badge>
              </span>
            )}
            <span className="grid h-11 w-11 origin-center place-items-center">
              <m.icon size={22} className="block" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-ink-900">{m.title}</p>
              <p className="mt-1 text-sm text-ink-500">{m.description}</p>
            </div>
            <span className="mt-auto flex items-center justify-center gap-1 text-sm font-medium text-brand-700 opacity-0 transition group-hover:opacity-100">
              Open <ArrowRight size={15} />
            </span>
          </Link>
        ))}
      </div>
    </>
  )
}
