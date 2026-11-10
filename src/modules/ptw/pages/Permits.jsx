import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { FileText, Plus, Search, MapPin, Calendar, ChevronRight } from 'lucide-react'
import { QRCodeCanvas } from 'qrcode.react'
import { PageHeader, EmptyState, Spinner } from '../components/ui'
import StatusBadge from '../components/StatusBadge'
import { publicPermitUrl } from '../lib/qr'
import { useAuth } from '../context/AuthContext'
import DocIdTag from '../../../shared/docId/DocIdTag'
import { usePermits } from '../context/PermitContext'
import { WORK_TYPES } from '../lib/ptwData'
import { STATUS, STATUS_META } from '../lib/permitStatus'

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: STATUS.DRAFT, label: 'Draft' },
  { key: STATUS.IN_PROGRESS, label: 'In Progress' },
  { key: STATUS.EXTENDED_IN_PROGRESS, label: 'Extended' },
  { key: STATUS.NOT_CLOSED, label: 'Not Closed' },
  { key: STATUS.OPEN_WITH_OBSERVATIONS, label: 'Unsafe Reported' },
  { key: STATUS.CLOSED, label: 'Closed' },
  { key: STATUS.CLOSED_NONCOMPLIANCE, label: 'Non-Compliance' },
]

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function Permits() {
  const navigate = useNavigate()
  const { profile, isApprover } = useAuth()
  const { permits, loading, sites } = usePermits()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [site, setSite] = useState('all')

  const visible = useMemo(() => {
    // Technicians only see permits they raised.
    const base = isApprover ? permits : permits.filter((p) => p.createdBy === profile?.uid)
    const q = search.trim().toLowerCase()
    return base.filter((p) => {
      if (status !== 'all' && p.status !== status) return false
      if (type !== 'all' && p.typeOfWork !== type) return false
      if (site !== 'all' && p.site !== site) return false
      if (q) {
        const hay = `${p.permitNo} ${p.jobLocation} ${p.issuedToName} ${p.typeOfWork} ${p.site || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [permits, isApprover, profile, search, status, type, site])

  return (
    <div>
      <PageHeader icon={FileText} title="Permits" subtitle={isApprover ? 'All permits across your organization' : 'Permits you have raised'} tourId="permits-header">
        <Link data-write to="/permits/new" className="btn-primary"><Plus size={16} /> New Permit</Link>
      </PageHeader>

      {/* Filters */}
      <div className="card mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="input pl-9" placeholder="Search permit no, location, person…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {sites.length > 0 && (
            <select className="input sm:w-48" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="all">All sites</option>
              {sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <select className="input sm:w-56" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All work types</option>
            {WORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => {
            const active = status === s.key
            const color = STATUS_META[s.key]?.color
            return (
              <button key={s.key} onClick={() => setStatus(s.key)}
                className={`chip transition ${active ? 'text-white' : 'bg-surface text-ink-600 hover:bg-surface-100'}`}
                style={active ? { backgroundColor: color || '#ea580c' } : undefined}>
                {s.label}
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="grid place-items-center py-20"><Spinner size={28} /></div>
      ) : visible.length === 0 ? (
        <EmptyState icon={FileText} title="No permits found" hint="Adjust the filters, or raise a new permit to get started."
          action={<Link data-write to="/permits/new" className="btn-primary mt-1"><Plus size={16} /> New Permit</Link>} />
      ) : (
        <div className="space-y-2.5">
          {visible.map((p, i) => (
            <motion.button
              key={p.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.02, 0.3) }}
              onClick={() => navigate(`/permits/${p.id}`)}
              className="card pressable flex w-full items-center gap-4 p-4 text-left"
            >
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 shadow-elev-sm">
                <FileText size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-ink-900">{p.permitNo}</span>
                  <DocIdTag id={p.docId} />
                  <span className="text-sm text-ink-500">· {p.typeOfWork}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-ink-500">
                  <span className="inline-flex items-center gap-1"><MapPin size={12} /> {p.jobLocation || '—'}</span>
                  <span className="inline-flex items-center gap-1"><Calendar size={12} /> {fmtDate(p.validFrom)}</span>
                  <span>Issued to {p.issuedToName || '—'}</span>
                </div>
              </div>
              {p.qrToken && (
                <div className="hidden flex-col items-center gap-0.5 sm:flex">
                  <div className="rounded-lg bg-white p-1 shadow-elev-sm">
                    <QRCodeCanvas value={publicPermitUrl(p.qrToken)} size={56} level="M" />
                  </div>
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-ink-400">Scan</span>
                </div>
              )}
              <StatusBadge status={p.status} />
              <ChevronRight size={18} className="shrink-0 text-ink-300" />
            </motion.button>
          ))}
        </div>
      )}
    </div>
  )
}
