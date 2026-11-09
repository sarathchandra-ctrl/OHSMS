import { useMemo } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { motion } from 'framer-motion'
import { Users as UsersIcon, Check, X, Shield } from 'lucide-react'
import { PageHeader, Badge, EmptyState } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useIncidents } from '../context/IncidentContext'
import { setUserStatus, setUserRole } from '../lib/firestore'
import { ROLES, roleLabel } from '../lib/permissions'

const ROLE_COLOR = { reporter: '#0891b2', investigator: '#795548', admin: '#dc2626' }

export default function Users() {
  const { users } = useIncidents()
  const { profile, user } = useAuth()
  const actor = { uid: user?.uid, name: profile?.name }

  const pending = useMemo(() => users.filter((u) => u.status === 'pending'), [users])
  const members = useMemo(() => users.filter((u) => u.status === 'approved'), [users])

  const approve = async (u) => { try { await setUserStatus(u.uid, 'approved', actor, u.name); toast.success(`${u.name} approved`) } catch (e) { toastCaught(e) } }
  const reject = async (u) => { try { await setUserStatus(u.uid, 'rejected', actor, u.name); toast(`${u.name} rejected`, { icon: '🚫' }) } catch (e) { toastCaught(e) } }
  const changeRole = async (u, role) => { try { await setUserRole(u.uid, role, actor, u.name); toast.success(`${u.name} → ${roleLabel(role)}`) } catch (e) { toastCaught(e) } }

  return (
    <div>
      <PageHeader title="Users" subtitle="Members, roles & approvals" icon={UsersIcon} tourId="users-header" />

      {pending.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-400">Pending approval ({pending.length})</h3>
          <div className="space-y-2">
            {pending.map((u) => (
              <motion.div key={u.uid} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="card flex items-center gap-3 p-4">
                <div className="grid h-10 w-10 place-items-center rounded-full bg-amber-100 text-sm font-bold text-amber-700">{u.name?.[0]?.toUpperCase() || '?'}</div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-ink-900">{u.name}</p>
                  <p className="truncate text-sm text-ink-500">{u.email}</p>
                </div>
                <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => approve(u)}><Check size={14} /> Approve</button>
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => reject(u)}><X size={14} /> Reject</button>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-400">Members ({members.length})</h3>
      {members.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No members yet" hint="Approved members will appear here." />
      ) : (
        <div className="space-y-2">
          {members.map((u) => {
            const isSelf = u.uid === user?.uid
            return (
              <motion.div key={u.uid} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="card flex flex-wrap items-center gap-3 p-4">
                <div className="grid h-10 w-10 place-items-center rounded-full bg-brand-100 text-sm font-bold text-brand-700">{u.name?.[0]?.toUpperCase() || '?'}</div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-bold text-ink-900">{u.name} {isSelf && <span className="text-xs font-normal text-ink-400">(you)</span>}</p>
                  <p className="truncate text-sm text-ink-500">{u.email}{u.dept ? ` · ${u.dept}` : ''}</p>
                </div>
                <Badge color={ROLE_COLOR[u.role] || '#64748b'}><Shield size={11} /> {roleLabel(u.role)}</Badge>
                <select className="input w-auto text-sm" value={u.role} disabled={isSelf} onChange={(e) => changeRole(u, e.target.value)} title={isSelf ? "You can't change your own role" : 'Change role'}>
                  {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}
