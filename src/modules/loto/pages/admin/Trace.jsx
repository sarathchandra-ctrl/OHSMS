import { useMemo, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useLocks } from '../../hooks/useLocks'
import { traceLock } from '../../utils/lockRegister'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Spinner from '../../components/ui/Spinner'

const STATUS_LABEL = { available: 'Available', issued: 'Issued', out_of_service: 'Out of service' }

// A lookup of the lock itself. It used to list the isolation permits a lock
// was on; those were removed from the app (2026-11-10).
export default function Trace() {
  const { profile } = useAuth()
  const { locks, loading } = useLocks()
  const [q, setQ] = useState('')
  const result = useMemo(() => traceLock(q, locks), [q, locks])

  if (!profile) return null
  if (loading) {
    return <div className="py-16"><Spinner label="Loading the lock register…" /></div>
  }

  const lock = result.lock
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>} />}
        title="Trace a lock"
        subtitle="Scan or type a lock number or a tag number."
      />
      <Card animate={false} className="!p-5">
        <Input label="Lock or tag" value={q} onChange={(e) => setQ(e.target.value)} placeholder="D-1 or RED-1" />
        <div className="mt-4 text-sm text-steel-200">
          {result.kind === 'empty' && <p>Enter a lock or tag number to see the lock in the register.</p>}
          {result.kind === 'none' && <p>No lock in the register has that number or tag.</p>}
          {result.kind === 'lock' && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-steel-400">Lock</dt>
              <dd className="font-mono font-bold">{lock.lockNo || '—'}</dd>
              <dt className="text-steel-400">Tag</dt>
              <dd>{lock.tagNo || '—'}</dd>
              <dt className="text-steel-400">Colour</dt>
              <dd className="capitalize">{lock.color || '—'}</dd>
              <dt className="text-steel-400">Type</dt>
              <dd className="capitalize">{lock.type || '—'}</dd>
              <dt className="text-steel-400">Status</dt>
              <dd>{STATUS_LABEL[lock.serviceStatus || 'available'] || lock.serviceStatus}</dd>
            </dl>
          )}
        </div>
      </Card>
    </div>
  )
}
