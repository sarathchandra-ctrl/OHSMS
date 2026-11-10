import { useMemo, useState } from 'react'
import { Bell, Check, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { PageHeader } from '../shared/ui'
import { useInbox } from '../shared/notifications/inboxContext'
import { dismiss, markAllRead } from '../shared/notifications/inbox'
import { lookOf } from '../shared/notifications/kinds'
import NotificationItem from '../shared/notifications/NotificationItem'
import { toastCaught } from '../shared/lib/toastCaught'

const FILTERS = [
  ['all', 'All'],
  ['unread', 'Unread'],
]

// Everything the bell has held for you. Each row opens the record or screen
// it is about; the bin beside it removes it from your list (the record it
// points at is not touched).
export default function Notifications() {
  const { uid, items, ready, unread } = useInbox()
  const [filter, setFilter] = useState('all')
  const [module, setModule] = useState('')

  const modules = useMemo(
    () => [...new Set(items.map((n) => lookOf(n.kind).module))].sort(),
    [items]
  )
  const shown = items.filter(
    (n) => (filter === 'all' || !n.readAt) && (!module || lookOf(n.kind).module === module)
  )

  const clearRead = async () => {
    const read = items.filter((n) => n.readAt)
    try {
      await Promise.all(read.map((n) => dismiss(uid, n.id)))
      toast.success(`Cleared ${read.length} read notification${read.length === 1 ? '' : 's'}`)
    } catch (err) {
      toastCaught(err, 'Could not clear')
    }
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={unread ? `${unread} unread` : 'You are up to date'}
        icon={Bell}
      />
      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Show" className="flex gap-1">
            {FILTERS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
                className={`nav-tab ${filter === key ? 'nav-tab-active' : 'nav-tab-idle'}`}
              >
                {label}
                {key === 'unread' && unread ? ` (${unread})` : ''}
              </button>
            ))}
          </div>
          {modules.length > 1 && (
            <label htmlFor="notify-module" className="flex items-center gap-2 text-sm text-ink-600">
              <span className="sr-only">Module</span>
              <select
                id="notify-module"
                value={module}
                onChange={(e) => setModule(e.target.value)}
                className="input h-9 py-1 text-sm"
              >
                <option value="">All modules</option>
                {modules.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex-1" />
          {unread > 0 && (
            <button
              type="button"
              className="btn-soft"
              onClick={() =>
                markAllRead(uid, items).catch((e) => toastCaught(e, 'Could not update'))
              }
            >
              <Check size={15} aria-hidden="true" /> Mark all read
            </button>
          )}
          {items.some((n) => n.readAt) && (
            <button type="button" className="btn-ghost" onClick={clearRead}>
              <Trash2 size={15} aria-hidden="true" /> Clear read
            </button>
          )}
        </div>

        <div className="card divide-y divide-ink-100 p-1.5">
          {!ready ? (
            <p className="px-3 py-10 text-center text-sm text-ink-500">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-ink-500">
              {items.length
                ? 'Nothing here with these filters.'
                : 'No notifications yet. New incidents, actions, permits, audits and training assigned to you appear here.'}
            </p>
          ) : (
            shown.map((n) => (
              <div key={n.id} className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <NotificationItem uid={uid} item={n} />
                </div>
                <button
                  type="button"
                  aria-label={`Remove “${n.title}”`}
                  onClick={() =>
                    dismiss(uid, n.id).catch((e) => toastCaught(e, 'Could not remove'))
                  }
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-ink-400 hover:bg-surface-100 hover:text-ink-700"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
