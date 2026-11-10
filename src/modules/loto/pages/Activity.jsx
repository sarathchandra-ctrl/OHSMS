import { useMemo, useState } from 'react'
import { useOrgEvents } from '../hooks/useOrgProcedures'
import { filterActivity, toMs } from '../utils/activity'
import PageHeader, { HdrIcon } from '../components/PageHeader'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'

export default function Activity() {
  const { events, loading } = useOrgEvents()
  const [q, setQ] = useState('')
  const [action, setAction] = useState('')
  const shown = useMemo(() => filterActivity(events, { q, action }), [events, q, action])
  const actions = useMemo(() => [...new Set(events.map((e) => e.action || e.type).filter(Boolean))].sort(), [events])

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><path d="M4 6h16M4 12h16M4 18h10" /></>} />}
        title="Activity"
        subtitle="Lock and permit events still inside the one-year retention window."
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Input label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="block text-sm text-steel-200">
          Action
          <select className="input mt-1 w-full" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      </div>
      {loading ? (
        <div className="py-16"><Spinner label="Loading activity…" /></div>
      ) : (
        <ul className="mt-4 divide-y divide-steel-700 rounded-xl border border-steel-700">
          {shown.length === 0 && <li className="px-4 py-3 text-sm text-steel-400">No matching events.</li>}
          {shown.map((e) => (
            <li key={e.id} className="px-4 py-3 text-sm">
              <span className="text-steel-400">{Number.isFinite(toMs(e.at)) ? new Date(toMs(e.at)).toLocaleString() : ''}</span>
              {' · '}
              <span className="font-semibold text-steel-100">{e.action || e.type}</span>
              {e.permitNo ? ` · ${e.permitNo}` : ''}
              {e.byName ? ` · ${e.byName}` : ''}
              {e.note ? ` · ${e.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
