import { Link, NavLink, useLocation } from 'react-router-dom'
import { AlertTriangle, Bell, ClipboardCheck, Home, QrCode, Wrench } from 'lucide-react'
import { useAlertUnread } from '../mobile/alertContext'
import { isShellHome, shellForMode } from '../mobile/viewMode'

// The phone's primary navigation. Rendered only in mobile view, from
// AppChrome. On a wide window that mode is a centred column, so the bar
// centres with it; on a phone it stays full width.
//
// Home is the grid. The other labels are the jobs that are not a module —
// sites and the registers live on that grid, so without Home the only way
// back was the header mark, which people do not read as a control. The
// target is the shell home (phone: /field, desktop: /portal), the same path
// the header mark uses. This bar is mounted only for the phone shell;
// homePath is passed in so the two cannot drift, and the default is the
// phone home for a render that did not go through the shell.
const ITEMS = [
  { to: '/field/scan', label: 'QR Scan', icon: QrCode },
  { to: '/field/tasks', label: 'Tasks', icon: ClipboardCheck },
  { to: '/incidents/new', label: 'Report', icon: AlertTriangle },
  { to: '/equipment/defects', label: 'Defects', icon: Wrench },
  { to: '/field/alerts', label: 'Alerts', icon: Bell },
]

// Shared with every control in the bar, including Home. A one-off class on
// Home is how it would end up a different height, a different focus ring,
// or a label the others do not use.
const ITEM_CLASS =
  'relative flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400'

function itemClass(isActive) {
  return `${ITEM_CLASS} ${isActive ? 'text-brand-700' : 'text-ink-500'}`
}

export default function FieldNav({ homePath = shellForMode('mobile').homePath }) {
  const unread = useAlertUnread()
  const { pathname } = useLocation()
  const homeCurrent = isShellHome(pathname, homePath)

  return (
    <nav
      aria-label="Field"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white/95 pb-[max(0.25rem,env(safe-area-inset-bottom))] backdrop-blur-xl print:hidden md:left-1/2 md:right-auto md:w-full md:max-w-md md:-translate-x-1/2 md:rounded-t-3xl md:border-x md:border-ink-200"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        <li className="flex flex-1">
          {/* Link, not NavLink. NavLink writes aria-current from its own `to`
              only. Sign-in still opens /portal while this control's target is
              /field, and both are the phone grid — so Home has to be current
              on either, which NavLink will not say. */}
          <Link
            to={homePath}
            aria-label="Home"
            aria-current={homeCurrent ? 'page' : undefined}
            className={itemClass(homeCurrent)}
          >
            <Home size={22} aria-hidden="true" />
            <span aria-hidden="true">Home</span>
          </Link>
        </li>
        {ITEMS.map((item) => {
          const badge = item.to === '/field/alerts' && unread > 0
          const name = badge ? `Alerts, ${unread} unread` : item.label
          return (
            <li key={item.to} className="flex flex-1">
              <NavLink
                to={item.to}
                end
                aria-label={name}
                className={({ isActive }) => itemClass(isActive)}
              >
                <item.icon size={22} aria-hidden="true" />
                {badge && (
                  <span
                    aria-hidden="true"
                    className="field-badge-pulse absolute right-[18%] top-1 grid min-h-[16px] min-w-[16px] place-items-center rounded-full bg-[#c43d32] px-1 text-[9px] font-bold leading-none text-white"
                  >
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
                <span aria-hidden="true">{item.label}</span>
              </NavLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
