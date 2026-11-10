import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { ClipboardList, Plus, Search, Filter, Trash2, ChevronRight, AlertTriangle, Download } from 'lucide-react'
import { PageHeader, Badge, EmptyState } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useIncidents } from '../context/IncidentContext'
import {
  INCIDENT_TYPE_BY_KEY, SEVERITY_BY_KEY, HSE_CATEGORY_BY_KEY, LIFECYCLE_BY_KEY,
  INCIDENT_TYPES, SEVERITY, LIFECYCLE,
} from '../lib/constants'
import { deleteIncident } from '../lib/incidents'
import { logAudit } from '../../../shared/org/orgData'
import { AUDIT } from '../../../shared/audit/audit'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

export default function Incidents() {
  const navigate = useNavigate()
  const { incidents, capped, loadCap } = useIncidents()
  const { isAdmin, profile, user } = useAuth()
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [severity, setSeverity] = useState('')
  const [lifecycle, setLifecycle] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return incidents.filter((i) => {
      if (q && !`${i.refNo} ${i.location} ${i.narrative}`.toLowerCase().includes(q)) return false
      if (type && i.type !== type) return false
      if (severity && i.severity !== severity) return false
      if (lifecycle && i.lifecycle !== lifecycle) return false
      // incidentDate is stored as YYYY-MM-DD, which compares correctly as a
      // string — no Date parsing, so no timezone shifting a boundary incident
      // into the wrong day. Both bounds are inclusive: someone asking for
      // "March" means the whole of it, including the 31st.
      if (from || to) {
        const d = i.incidentDate || ''
        // An incident with no date cannot be shown to fall inside a range.
        // Including it would inflate a bounded total with nothing to notice.
        if (!d) return false
        if (from && d < from) return false
        if (to && d > to) return false
      }
      return true
    })
  }, [incidents, search, type, severity, lifecycle, from, to])

  const doExport = async () => {
    if (!filtered.length) return toast.error('Nothing to export')
    try {
      const { exportIncidents } = await import('../lib/exporter')
      const { incidents: n, actions, chronology } = exportIncidents(filtered, `incidents-${filtered.length}.xlsx`)
      // A copy of the incident register — narratives, root causes and the state
      // of every action — has just left the system on someone's disk. There is
      // no preventive control available for that in a browser-only
      // architecture: an export is a read the reader is entitled to make. What
      // remains is a record that it happened, and by whom.
      //
      // It carries no injury columns, and must not grow any. This comment used
      // to claim "the injury detail behind them", which was never true of
      // exporter.js and would have been the wrong thing to build: the detail
      // lives in /injuries, which most people holding this button cannot read,
      // so a medical column here would be blank for them — and a blank medical
      // cell is indistinguishable from an uninjured person.
      logAudit({ uid: user?.uid, name: profile?.name }, AUDIT.EXPORT, {
        module: 'incidents',
        targetLabel: `${n} incidents, ${actions} actions, ${chronology} chronology events`,
        summary: `Exported ${n} incidents (${filtered.length === incidents.length ? 'whole register' : 'filtered'})`,
      })
      toast.success(`Exported ${n} incident${n === 1 ? '' : 's'}, ${actions} action${actions === 1 ? '' : 's'} and ${chronology} chronology event${chronology === 1 ? '' : 's'}`)
    } catch (err) {
      toastCaught(err, 'Export failed')
    }
  }

  const onDelete = async (e, inc) => {
    e.stopPropagation()
    if (!window.confirm(`Delete incident ${inc.refNo}? It can be restored from the Recycle Bin.`)) return
    try {
      await deleteIncident(inc.id, { uid: user.uid, name: profile.name })
      toast.success('Incident moved to Recycle Bin')
    } catch (err) {
      toastCaught(err, 'Could not delete')
    }
  }

  return (
    <div>
      <PageHeader title="Incidents" subtitle={`${incidents.length} recorded`} icon={ClipboardList} tourId="incidents-header">
        {/* Exports what the filters are currently showing, not the whole
            register: the filters are on the next line, and a button that
            ignored them would hand back a different list from the one on
            screen. Lazy — xlsx is a large dependency and most visits to this
            page never export. */}
        <button type="button" className="btn-ghost" onClick={doExport}>
          <Download size={16} /> Export
        </button>
        <Link data-write to="/incidents/new" className="btn-primary"><Plus size={16} /> Report Incident</Link>
      </PageHeader>

      {capped && (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertTriangle size={16} /> Showing the most recent {loadCap.toLocaleString()} incidents.
        </div>
      )}

      <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
        <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400"><Filter size={13} /> Filters</span>
        <div className="relative min-w-[200px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search ref, location, narrative…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {INCIDENT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select className="input w-auto" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">All severities</option>
          {SEVERITY.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="input w-auto" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
          <option value="">All stages</option>
          {LIFECYCLE.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
        </select>

        {/* Labelled rather than two bare date boxes: a pair of unlabelled
            inputs beside four dropdowns gives no clue which way round they go. */}
        <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-500">
          From
          <input
            type="date"
            className="input w-auto font-mono"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-500">
          To
          <input
            type="date"
            className="input w-auto font-mono"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>

        {(search || type || severity || lifecycle || from || to) && (
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => { setSearch(''); setType(''); setSeverity(''); setLifecycle(''); setFrom(''); setTo('') }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Says what the export and the list below are actually covering. Without
          it a narrowed range looks identical to a quiet quarter. */}
      {(from || to) && (
        <p className="mb-3 text-xs text-ink-500">
          Showing {filtered.length} of {incidents.length} incidents
          {from ? ` from ${from}` : ''}{to ? ` to ${to}` : ''}.
        </p>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No incidents found" hint={incidents.length ? 'Try clearing filters.' : 'Report your first incident to get started.'} action={<Link data-write to="/incidents/new" className="btn-primary"><Plus size={16} /> Report Incident</Link>} />
      ) : (
        <div className="space-y-2">
          {filtered.map((inc, i) => {
            const t = INCIDENT_TYPE_BY_KEY[inc.type]
            const sev = SEVERITY_BY_KEY[inc.severity]
            const cat = HSE_CATEGORY_BY_KEY[inc.category]
            const lc = LIFECYCLE_BY_KEY[inc.lifecycle]
            return (
              <motion.div
                key={inc.id}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}
                onClick={() => navigate(`/incidents/${inc.id}`)}
                className="card group flex cursor-pointer items-center gap-4 p-4 transition hover:-translate-y-0.5 hover:shadow-glow"
              >
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white" style={{ backgroundColor: sev?.color || '#64748b' }}>
                  <span className="text-xs font-black">{sev?.label?.[0] || '?'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-extrabold text-ink-900">{inc.refNo}</span>
                    {t && <Badge color={t.color}>{t.label}</Badge>}
                    {lc && <Badge color={lc.color}>{lc.label}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-ink-500">
                    {fmtDate(inc.incidentDate ? new Date(inc.incidentDate) : inc.createdAt)} · {inc.location || 'No location'} · {cat?.label || 'Uncategorized'}
                  </p>
                </div>
                {isAdmin && (
                  <button onClick={(e) => onDelete(e, inc)} className="rounded-lg p-2 text-ink-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100" title="Delete">
                    <Trash2 size={16} />
                  </button>
                )}
                <ChevronRight size={18} className="shrink-0 text-ink-300" />
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}
