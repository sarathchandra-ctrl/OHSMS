import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ScrollText, Search } from 'lucide-react'
import { PageHeader, Badge, EmptyState } from '../components/ui'
import { subscribeAuditLogs } from '../lib/data'
import { auditMeta } from '../lib/audit'

function fmtTime(ts) {
  if (!ts) return '—'
  const d = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

export default function AuditLog() {
  const [logs, setLogs] = useState([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    return subscribeAuditLogs(setLogs)
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return logs
    return logs.filter((l) => `${l.actorName} ${l.action} ${l.targetLabel} ${l.summary}`.toLowerCase().includes(q))
  }, [logs, search])

  return (
    <div>
      <PageHeader title="Audit Log" subtitle="Immutable, append-only change trail" icon={ScrollText} />

      <div className="card mb-4 flex items-center gap-3 p-4">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search actor, action, target…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries" hint="Actions across the app are recorded here." />
      ) : (
        <div className="space-y-1.5">
          {filtered.map((l, i) => {
            const m = auditMeta(l.action)
            return (
              <motion.div key={l.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.01, 0.2) }} className="card flex flex-wrap items-center gap-3 p-3">
                <Badge color={m.color}>{m.label}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink-800"><span className="font-semibold">{l.actorName}</span>{l.targetLabel ? ` · ${l.targetLabel}` : ''}{l.summary ? ` — ${l.summary}` : ''}</p>
                </div>
                <span className="text-xs text-ink-400">{fmtTime(l.at)}</span>
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}
