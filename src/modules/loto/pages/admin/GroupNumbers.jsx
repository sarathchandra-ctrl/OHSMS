import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { useAuth } from '../../context/AuthContext'
import { addGroupNumber, subscribeGroupNumbers } from '../../services/groupNumbers'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'

export default function GroupNumbers() {
  const { platformRole } = useAuth()
  const isAdmin = platformRole === 'admin'
  const [rows, setRows] = useState(null)
  const [no, setNo] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    return subscribeGroupNumbers(setRows)
  }, [])

  async function onAdd(e) {
    e.preventDefault()
    if (!isAdmin) return
    setSaving(true)
    try {
      await addGroupNumber({ no, description })
      setNo('')
      setDescription('')
      toast.success('Group number registered')
    } catch (err) {
      toastCaught(err, 'Could not register that number')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><rect x="4" y="8" width="16" height="10" rx="2" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>} />}
        title="Group lockout numbers"
        subtitle="A number can be on one open permit. Everyone comes off before the primary."
      />
      {isAdmin && (
        <Card animate={false} className="mt-4 !p-5">
          <form onSubmit={onAdd} className="grid gap-3 sm:grid-cols-[160px_1fr_auto] sm:items-end">
            <Input label="Number" value={no} onChange={(e) => setNo(e.target.value)} placeholder="GL-1" />
            <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Yard box" />
            <Button type="submit" loading={saving}>Register</Button>
          </form>
        </Card>
      )}
      {rows == null ? (
        <div className="py-16"><Spinner label="Loading group numbers…" /></div>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-steel-300">No group numbers yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-steel-700 rounded-xl border border-steel-700">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span>
                <span className="font-mono font-bold text-steel-100">{row.no || row.id}</span>
                {row.description ? <span className="ml-2 text-steel-300">{row.description}</span> : null}
              </span>
              <span className={row.openPermitId ? 'font-semibold text-amber-700' : 'text-steel-400'}>
                {row.openPermitId ? `On ${row.openPermitId}` : 'Free'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!isAdmin && <p className="mt-4 text-sm text-steel-300">Only an Admin can register a number.</p>}
    </div>
  )
}
