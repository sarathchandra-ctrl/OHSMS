import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Activity, Plus, Search, Trash2, ChevronRight, Link2 } from 'lucide-react'
import { PageHeader, Badge, EmptyState } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useIncidents } from '../context/IncidentContext'
import { LIFECYCLE_BY_KEY } from '../lib/constants'
import { deleteIllness } from '../lib/illnesses'
import { formatDate } from '../../../shared/lib/format'

function fmtDate(v) {
  if (!v) return '—'
  const d = v.seconds ? new Date(v.seconds * 1000) : new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : formatDate(d)
}

export default function Illnesses() {
  const navigate = useNavigate()
  const { illnesses, incidents } = useIncidents()
  const { isAdmin, profile, user } = useAuth()
  const [search, setSearch] = useState('')

  const refByIncidentId = useMemo(() => Object.fromEntries(incidents.map((i) => [i.id, i.refNo])), [incidents])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return illnesses.filter((i) => !q || `${i.refNo} ${i.exposedToAgent} ${i.location} ${i.healthIssue}`.toLowerCase().includes(q))
  }, [illnesses, search])

  const onDelete = async (e, ill) => {
    e.stopPropagation()
    if (!window.confirm(`Delete illness ${ill.refNo}? It can be restored from the Recycle Bin.`)) return
    try {
      await deleteIllness(ill.id, { uid: user.uid, name: profile.name })
      toast.success('Moved to Recycle Bin')
    } catch (err) {
      toastCaught(err, 'Could not delete')
    }
  }

  return (
    <div>
      <PageHeader title="Illness Reports" subtitle={`${illnesses.length} recorded`} icon={Activity} tourId="illness-header">
        <Link data-write to="/incidents/illness/new" className="btn-primary"><Plus size={16} /> Report Illness</Link>
      </PageHeader>

      <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-[200px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search ref, agent, location, health issue…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Activity} title="No illness reports" hint={illnesses.length ? 'Try a different search.' : 'Report an occupational illness to get started.'} action={<Link data-write to="/incidents/illness/new" className="btn-primary"><Plus size={16} /> Report Illness</Link>} />
      ) : (
        <div className="space-y-2">
          {filtered.map((ill, i) => {
            const lc = LIFECYCLE_BY_KEY[ill.lifecycle]
            return (
              <motion.div key={ill.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}
                onClick={() => navigate(`/incidents/illness/${ill.id}`)}
                className="card group flex cursor-pointer items-center gap-4 p-4 transition hover:-translate-y-0.5 hover:shadow-glow">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-cyan-500/15 text-cyan-600"><Activity size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-extrabold text-ink-900">{ill.refNo}</span>
                    {ill.exposedToAgent && <Badge color="#0891b2">{ill.exposedToAgent}</Badge>}
                    {lc && <Badge color={lc.color}>{lc.label}</Badge>}
                    {ill.linkedIncidentId && refByIncidentId[ill.linkedIncidentId] && (
                      <span className="inline-flex items-center gap-1 text-xs text-ink-400"><Link2 size={11} /> {refByIncidentId[ill.linkedIncidentId]}</span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-ink-500">{fmtDate(ill.date ? new Date(ill.date) : ill.createdAt)} · {ill.location || 'No location'} · {(ill.affectedPersonnel || []).length} affected</p>
                </div>
                {isAdmin && (
                  <button onClick={(e) => onDelete(e, ill)} className="rounded-lg p-2 text-ink-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100" title="Delete"><Trash2 size={16} /></button>
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
