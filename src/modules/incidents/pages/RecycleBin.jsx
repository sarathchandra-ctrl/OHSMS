import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { motion } from 'framer-motion'
import { Trash2, RotateCcw, X, ClipboardList, Activity, HeartPulse } from 'lucide-react'
import { PageHeader, EmptyState } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useIncidents } from '../context/IncidentContext'
import { restoreIncident, purgeIncident } from '../lib/incidents'
import { restoreIllness, purgeIllness } from '../lib/illnesses'
import { restoreInjury, purgeInjury } from '../lib/injuries'

/**
 * What each kind of deleted record is called, drawn with, and restored by.
 *
 * A table rather than the `if incident … else …` this used to be. That shape
 * was correct for exactly two kinds and silently wrong for three: adding
 * injuries to the list without touching it would have sent every injury down
 * the illness branch, calling restoreIllness on an id in another collection.
 * The failure would have been a toast saying nothing happened.
 */
const KINDS = {
  incident: {
    label: 'Incident',
    icon: ClipboardList,
    colour: '#795548',
    restore: restoreIncident,
    purge: purgeIncident,
  },
  illness: {
    label: 'Illness',
    icon: Activity,
    colour: '#0891b2',
    restore: restoreIllness,
    purge: purgeIllness,
  },
  injury: {
    label: 'Injury report',
    icon: HeartPulse,
    colour: '#be123c',
    restore: restoreInjury,
    purge: purgeInjury,
  },
}

export default function RecycleBin() {
  const { deletedIncidents, deletedIllnesses, deletedInjuries, canReadHealth } = useIncidents()
  const { profile, user } = useAuth()
  const actor = { uid: user?.uid, name: profile?.name }

  const items = [
    ...deletedIncidents.map((i) => ({ ...i, _kind: 'incident', _label: i.refNo })),
    ...deletedIllnesses.map((i) => ({ ...i, _kind: 'illness', _label: i.refNo })),
    // An injury has no reference of its own — it is keyed
    // `${incidentId}__${personId}` and identified by the incident it came from.
    // The person's name is sealed under the medical key class and is NOT put
    // here: this row names a record, not a colleague.
    ...deletedInjuries.map((i) => ({ ...i, _kind: 'injury', _label: i.incidentRefNo || i.id })),
  ]

  const restore = async (it) => {
    try {
      await KINDS[it._kind].restore(it.id, actor)
      toast.success(`${it._label} restored`)
    } catch (e) { toastCaught(e, 'Could not restore') }
  }
  const purge = async (it) => {
    if (!window.confirm(`Permanently delete ${it._label}? This cannot be undone.`)) return
    try {
      await KINDS[it._kind].purge(it.id, actor, it._label)
      toast.success(`${it._label} permanently deleted`)
    } catch (e) { toastCaught(e, 'Could not purge') }
  }

  return (
    <div>
      {/* Says the window out loud. These records now expire on a schedule, and
          this screen previously implied they were kept indefinitely — an
          illness record carrying health data disappearing without warning is
          worse than one kept too long. */}
      <PageHeader
        title="Recycle Bin"
        subtitle={
          canReadHealth
            ? 'Soft-deleted incidents, illnesses & injury reports — restore, or purge permanently. Anything left here is deleted automatically after 30 days.'
            : 'Soft-deleted incidents — restore, or purge permanently. Anything left here is deleted automatically after 30 days. Deleted illness and injury records are not shown: reading them is restricted to admins and managers.'
        }
        icon={Trash2}
      />
      {items.length === 0 ? (
        <EmptyState icon={Trash2} title="Recycle bin is empty" hint="Deleted records can be restored from here." />
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <motion.div key={`${it._kind}:${it.id}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="card flex items-center gap-3 p-4">
              <div className="grid h-10 w-10 place-items-center rounded-xl text-white" style={{ backgroundColor: KINDS[it._kind].colour }}>
                {(() => { const Icon = KINDS[it._kind].icon; return <Icon size={18} /> })()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-ink-900">{it._label}</p>
                <p className="truncate text-sm text-ink-500">{KINDS[it._kind].label} · deleted by {it.deletedBy || 'unknown'}</p>
              </div>
              <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => restore(it)}><RotateCcw size={14} /> Restore</button>
              <button className="btn-danger px-3 py-1.5 text-xs" onClick={() => purge(it)}><X size={14} /> Delete forever</button>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}
