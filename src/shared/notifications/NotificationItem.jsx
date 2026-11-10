import { useNavigate } from 'react-router-dom'
import { ago, markRead, safeLink } from './inbox'
import { lookOf } from './kinds'

/**
 * One notification. Clicking or tapping it marks it read and opens the record
 * or screen it is about. A real <button>, so it works from the keyboard and a
 * screen reader announces it, unread state included.
 */
export default function NotificationItem({ uid, item, onOpen, compact = false }) {
  const navigate = useNavigate()
  const look = lookOf(item.kind)
  const Icon = look.icon
  const unread = !item.readAt
  const link = safeLink(item.link)

  const open = () => {
    if (unread) markRead(uid, item.id).catch(() => {})
    onOpen?.()
    if (link) navigate(link)
  }

  return (
    <button
      type="button"
      onClick={open}
      className={`flex w-full items-start gap-3 rounded-2xl px-3 text-left transition-colors hover:bg-surface-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 ${compact ? 'py-2' : 'py-3'} ${unread ? 'bg-brand-50/60' : ''}`}
    >
      <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl ${look.tone}`}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={`block min-w-0 flex-1 truncate text-[13px] ${unread ? 'font-bold text-ink-900' : 'font-semibold text-ink-700'}`}
          >
            {item.title}
          </span>
          {unread && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600">
              <span className="sr-only">Unread</span>
            </span>
          )}
        </span>
        {!compact && item.summary && (
          <span className="mt-0.5 block text-[12.5px] text-ink-600">{item.summary}</span>
        )}
        <span className="mt-0.5 block text-[11px] text-ink-400">
          {look.module} · {ago(item.createdAt)}
        </span>
      </span>
    </button>
  )
}
