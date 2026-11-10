import { useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useReadOnly } from '../auth/AuthContext'

/**
 * Secondary nav used by every module.
 *
 * There used to be a copy of this in each module's index, and three of them
 * (CCTV, stakeholder, objectives) had drifted into a different look — dark
 * pills vs filled chips vs brand fill — so moving between modules felt like
 * changing products. One component, one active state, and a phone can scroll
 * the row sideways instead of wrapping it into a tall stack of tabs.
 *
 * `toFor` exists for CCTV: the site filter lives in the query string and a
 * bare `to` would drop it on every tab change.
 * `active` on a tab exists for Emergency Response, whose site-detail URLs
 * sit under the first tab without matching `end`.
 */
export default function ModuleTabs({ tabs, label = 'Module sections', toFor, className = '' }) {
  const navRef = useRef(null)
  const { pathname } = useLocation()
  // `write` tabs (imports, admin workspaces) are only writes: a view-only
  // role does not see them.
  const readOnly = useReadOnly()
  // On a phone the row is wider than the screen. Bring the active pill into
  // view, so a tab near the end is not selected and yet off-screen. Only the
  // strip's own horizontal scroll moves; the page does not.
  useEffect(() => {
    const nav = navRef.current
    const active = nav?.querySelector('.nav-tab-active')
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return
    const n = nav.getBoundingClientRect()
    const t = active.getBoundingClientRect()
    if (t.left < n.left) nav.scrollLeft -= n.left - t.left + 8
    else if (t.right > n.right) nav.scrollLeft += t.right - n.right + 8
  }, [pathname])
  return (
    <nav ref={navRef} aria-label={label} className={`tab-strip mb-5 print:hidden ${className}`}>
      {tabs
        .filter((t) => !t.hidden && !(readOnly && t.write))
        .map((t) => (
          <NavLink
            key={t.to}
            to={toFor ? toFor(t.to) : t.to}
            end={t.end}
            className={({ isActive }) => {
              const active = t.active != null ? t.active : isActive
              return ['nav-tab', active ? 'nav-tab-active' : 'nav-tab-idle'].join(' ')
            }}
          >
            {t.icon ? <t.icon size={16} /> : null}
            {t.label}
          </NavLink>
        ))}
    </nav>
  )
}
