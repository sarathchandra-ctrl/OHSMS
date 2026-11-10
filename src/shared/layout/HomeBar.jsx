import { Link, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { moduleForPath } from '../modules/registry'
import { OrgMark } from '../branding/OrgMark'

/**
 * Where you are, and the two ways out.
 *
 * The header carries a logo that goes to the portal, but a logo is not a
 * signpost — people do not read it as "home", and on a sub-page three levels
 * into a module there was no way back to the module's own front page at all
 * except the browser button.
 *
 * So: always an app Home, plus the module's own home whenever you are past it.
 * Rendered once here rather than added to forty pages, which also means it
 * cannot drift out of step between modules.
 *
 * Hidden on the portal itself and on the loading screens — offering "Home" to
 * someone already standing on it is noise.
 *
 * It reads as a bar rather than a line of small print because it stopped being
 * legible otherwise: the trail was 12px semibold in ink-500, which landed
 * below AA against the old page canvas. Raising it onto a white surface buys
 * the contrast (ink-800 on surface is well past 4.5:1) and, more usefully,
 * gives the thing an edge — navigation that is flush with the page reads as a
 * caption for the page rather than a control. The brand mark anchors the Home
 * end so the way out is findable by shape before it is read.
 */
export default function HomeBar() {
  const { pathname } = useLocation()

  // The portal IS home. Its own sub-pages get a way back; its root gets nothing.
  if (pathname === '/portal' || pathname === '/') return null

  const mod = moduleForPath(pathname)
  // Past the module's front page — /cctv/inventory but not /cctv.
  const insideModule = mod && pathname !== mod.path
  const here = currentLabel(pathname, mod)

  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-5 flex flex-wrap items-center gap-0.5 rounded-2xl bg-white/70 px-2 py-1.5 text-sm font-semibold ring-1 ring-ink-200 backdrop-blur-xl"
    >
      <Link
        to="/portal"
        className="flex items-center gap-2 rounded-xl px-2 py-1 text-ink-800 transition-colors hover:bg-surface-100 hover:text-brand-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        {/* Decorative: the word "Home" already names this link, so announcing
            the mark as well would just make the trail read twice.

            The org's own logo, matching the header — the trail and the corner
            it points back to have to be the same shape, or the mark stops
            working as "the way home". */}
        <OrgMark className="h-5 w-5 rounded-lg ring-1 ring-ink-200" />
        Home
      </Link>

      {mod && (
        <>
          <ChevronRight size={15} className="flex-none text-ink-500" aria-hidden="true" />
          {insideModule ? (
            <Link
              to={mod.path}
              className="rounded-xl px-2 py-1 text-ink-700 transition-colors hover:bg-surface-100 hover:text-brand-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              {mod.label}
            </Link>
          ) : (
            // Already on the module's front page: name it, do not link it to
            // itself — a link that does nothing teaches people not to trust the
            // rest of the trail.
            <span className="px-2 py-1 text-brand-700" aria-current="page">
              {mod.label}
            </span>
          )}
        </>
      )}

      {here && (
        <>
          <ChevronRight size={15} className="flex-none text-ink-500" aria-hidden="true" />
          <span className="px-2 py-1 text-brand-700" aria-current="page">
            {here}
          </span>
        </>
      )}
    </nav>
  )
}

const PORTAL_PAGES = {
  '/portal/training': 'My training',
}

// Named field pages only. /field/asset/<token> is labelled "Equipment": the
// token is a credential and the trail is visible text, not a place to repeat it.
const FIELD_PAGES = {
  '/field/scan': 'QR Scan',
  '/field/tasks': 'Tasks',
  '/field/alerts': 'Alerts',
}

const ADMIN_LABELS = {
  dashboard: 'Dashboard',
  security: 'Security',
  analytics: 'Analytics',
  sites: 'Sites',
  users: 'Employees',
  settings: 'Org settings',
  'audit-log': 'Audit log',
  maintenance: 'Maintenance',
}

/**
 * The last crumb when it is not the module's own name.
 *
 * Portal sub-pages used to render a trail that was only "Home": `onPortal`
 * hid the admin-label branch, and portal routes are not modules, so the
 * person standing on My actions had no indication of where they were.
 */
function currentLabel(pathname, mod) {
  if (mod) return null
  if (PORTAL_PAGES[pathname]) return PORTAL_PAGES[pathname]
  if (FIELD_PAGES[pathname]) return FIELD_PAGES[pathname]
  if (pathname.startsWith('/field/asset/')) return 'Equipment'
  const seg = pathname.split('/').filter(Boolean)[0] || ''
  return ADMIN_LABELS[seg] || seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ')
}
