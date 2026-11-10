import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { useInbox } from './inboxContext'
import { markAllRead } from './inbox'
import NotificationItem from './NotificationItem'

const PREVIEW = 6

/** The header bell: unread count, the latest few, and the way to all of them. */
export default function NotificationBell() {
  const { uid, items, unread } = useInbox()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Dismissed by a tap or click anywhere else, and by Escape: a panel only its
  // own button can close is a trap on a touch screen.
  useEffect(() => {
    if (!open) return undefined
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const esc = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  if (!uid) return null
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications'

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        aria-controls="notification-panel"
        className="relative grid h-9 w-9 place-items-center rounded-2xl bg-white/80 text-ink-600 ring-1 ring-ink-200 transition-all duration-200 hover:text-ink-900 hover:ring-ink-300 active:scale-[0.97] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        <Bell size={17} aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id="notification-panel"
          role="dialog"
          aria-label="Notifications"
          className="fixed inset-x-3 top-16 z-40 overflow-hidden rounded-3xl bg-white shadow-elev-lg ring-1 ring-ink-200 animate-fade-in-up sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-96"
        >
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <p className="text-[13px] font-bold text-ink-900">Notifications</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAllRead(uid, items).catch(() => {})}
                className="rounded-lg px-2 py-1 text-[12px] font-semibold text-brand-700 hover:bg-brand-50"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-[13px] text-ink-500">
                Nothing yet. You’ll be told here when something needs you.
              </p>
            ) : (
              items
                .slice(0, PREVIEW)
                .map((n) => (
                  <NotificationItem
                    key={n.id}
                    uid={uid}
                    item={n}
                    compact
                    onOpen={() => setOpen(false)}
                  />
                ))
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate('/notifications')
            }}
            className="block w-full border-t border-ink-100 px-4 py-3 text-center text-[13px] font-semibold text-brand-700 hover:bg-brand-50"
          >
            View all notifications
          </button>
        </div>
      )}
    </div>
  )
}
