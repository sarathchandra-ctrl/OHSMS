// ─────────────────────────────────────────────────────────────────────────────
// The one shell.
//
// There used to be two: the portal had its own header, and every module page
// rendered inside a different one. Same app, same person, two sets of
// navigation depending on which link they happened to follow — so opening a
// module felt like leaving the product.
//
// This is the portal header, used everywhere. Module pages render inside it
// exactly as portal pages do, which is why it takes children rather than
// assuming an Outlet: the portal routes nest, the module routes do not.
//
// It carries no navigation. The portal home is the only hub — every module and
// every personal page is a tile or a button there — so the bar holds identity
// and account, and nothing that competes with the page below it.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { Building2, ChevronDown, LogOut, GraduationCap, KeyRound, ShieldCheck } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { initials } from '../lib/format'
import RequestAccessModal from './RequestAccessModal'
import Sam from '../sam/Sam'
import HomeBar from './HomeBar'
import FieldNav from './FieldNav'
import { AlertProvider } from '../mobile/useAlertFeed'
import { OrgMark, hasOrgLogo } from '../branding/OrgMark'
import IdleGuard from '../auth/IdleGuard'
import { shellForMode } from '../mobile/viewMode'
import { useViewMode, ViewModeProvider } from '../mobile/viewModeContext'

const ROLE_LABEL = {
  admin: 'Administrator',
  manager: 'Manager',
  auditor: 'Auditor',
  member: 'Employee',
}

export default function AppChrome({ children }) {
  return (
    <ViewModeProvider>
      <AppChromeInner>{children}</AppChromeInner>
    </ViewModeProvider>
  )
}

function AppChromeInner({ children }) {
  const { profile, org, orgName, role, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const reduce = useReducedMotion()
  const [menuOpen, setMenuOpen] = useState(false)
  const [reqOpen, setReqOpen] = useState(false)
  const menuRef = useRef(null)

  // A menu that can only be dismissed by the button that opened it is a trap on
  // a touch screen.
  useEffect(() => {
    if (!menuOpen) return undefined
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return undefined
    const items = menuRef.current?.querySelectorAll('[role="menuitem"]')
    items?.[0]?.focus?.({ preventScroll: true })
    return undefined
  }, [menuOpen])

  const onMenuKeyDown = (e) => {
    const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])
    if (!items.length) return
    const i = items.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(i + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i <= 0 ? items.length : i) - 1]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  // The phone chrome follows the view mode, not the viewport. A phone that
  // asked for the desktop portal must not keep the field bar, and a desktop
  // window that asked for the phone home must not lose it. The alerts route
  // still needs the feed when it is opened from desktop view.
  const { mode } = useViewMode()
  const shell = shellForMode(mode)
  const alertsOn = shell.listenForAlerts || location.pathname.startsWith('/field/alerts')
  const name = profile?.name || 'There'
  // The wordmark beside the mark names the ORGANIZATION once it has a logo of
  // its own. Leaving "WEHS / Workplace Environment, Health & Safety" standing
  // next to a customer's logo reads as a co-brand nobody agreed to.
  // `hasOrgLogo` (not `logoUrl` alone): uploads after M-5 often store only
  // `logoPath`, and treating the empty URL as "no logo" kept the vendor name
  // in the header after a successful upload.
  const branded = hasOrgLogo(org)

  return (
    <AlertProvider enabled={alertsOn}>
      <div className="min-h-screen bg-canvas" data-view-mode={mode}>
        {/* Skip link. The header carries the wordmark, the module switcher, the
          notification bell and the account menu, and it is sticky — so on every
          single route a keyboard user tabbed through all of it before reaching
          the page they had just navigated to. Visually hidden until focused,
          which is the point: it costs nothing to anyone who does not need it. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-2xl focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to main content
        </a>
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-ink-200/80 bg-white/72 px-4 py-2.5 pt-[max(0.65rem,env(safe-area-inset-top))] backdrop-blur-2xl sm:gap-3.5 sm:px-7">
          {/* aria-label rather than leaning on the wordmark beside it: that
            text is hidden below sm. The organisation name shown on a phone is
            a separate line, and without this label the home link was announced
            as the single letter "W". */}
          <NavLink
            to={shell.homePath}
            aria-label={`${branded && orgName ? orgName : 'Cult Fit SMS'} home`}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas sm:flex-none"
          >
            <OrgMark className="h-8 w-8 shrink-0 rounded-xl ring-1 ring-ink-200" />
            {/* Below sm the wordmark and the building row are both hidden, so
                a phone showed a mark and initials and never who was signed in.
                This line is only that gap. sm and up keep the wordmark. */}
            <span className="min-w-0 sm:hidden">
              <span className="block truncate text-[13px] font-extrabold tracking-[-0.02em] text-ink-900">
                {orgName || 'Your organization'}
              </span>
            </span>
            <span className="hidden min-w-0 leading-tight sm:block">
              <span className="block truncate text-[13px] font-extrabold tracking-[-0.02em] text-ink-900">
                {branded ? orgName || 'Your organization' : 'Cult Fit SMS'}
              </span>
              <span className="block truncate text-[11px] text-ink-400">
                {branded
                  ? 'Occupational Health & Safety'
                  : 'Workplace Environment, Health & Safety'}
              </span>
            </span>
          </NavLink>

          <div className="hidden flex-1 sm:block" />

          <div className="ml-1.5 hidden min-w-0 items-center gap-2 border-l border-ink-200 pl-3.5 lg:flex">
            <Building2 size={15} className="shrink-0 text-ink-400" />
            <span className="truncate text-[13px] font-semibold text-ink-700">
              {orgName || 'Your organization'}
            </span>
          </div>

          <div className="relative min-w-0 max-w-[48%] sm:max-w-none" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-controls="account-menu"
              className="flex max-w-full items-center gap-1.5 rounded-2xl bg-white/80 px-1.5 py-1 ring-1 ring-ink-200 transition-all duration-200 ease-emil hover:ring-ink-300 active:scale-[0.98] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas sm:gap-2.5 sm:px-2 sm:py-1.5"
            >
              <span className="grid h-[28px] w-[28px] shrink-0 place-items-center rounded-2xl bg-brand-600 text-[11px] font-bold text-white shadow-elev-sm">
                {initials(name)}
              </span>
              <span className="min-w-0 truncate text-[12.5px] font-bold text-ink-900 sm:hidden">
                {name}
              </span>
              <span className="hidden text-left leading-tight sm:block">
                <span className="block text-[12.5px] font-bold text-ink-900">{name}</span>
                <span className="block text-[10.5px] text-ink-400">
                  {ROLE_LABEL[role] || 'Employee'}
                  {role === 'auditor' ? ' · View only' : ''}
                </span>
              </span>
              <ChevronDown
                size={14}
                className={`shrink-0 text-ink-400 transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {menuOpen && (
              <div
                id="account-menu"
                role="menu"
                tabIndex={-1}
                onKeyDown={onMenuKeyDown}
                className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-3xl bg-white/92 p-1.5 shadow-elev-lg ring-1 ring-ink-200 backdrop-blur-2xl animate-fade-in-up"
              >
                <div className="border-b border-ink-100 px-3 py-2.5">
                  <p className="text-[13px] font-bold text-ink-900">{name}</p>
                  <p className="truncate text-[11.5px] text-ink-400">{profile?.email}</p>
                  <p className="mt-0.5 truncate text-[11.5px] text-ink-400">{orgName}</p>
                </div>
                <MenuItem
                  icon={GraduationCap}
                  onClick={() => {
                    setMenuOpen(false)
                    navigate('/portal/training')
                  }}
                >
                  My training record
                </MenuItem>
                <MenuItem
                  icon={KeyRound}
                  onClick={() => {
                    setMenuOpen(false)
                    setReqOpen(true)
                  }}
                >
                  Request access
                </MenuItem>
                <MenuItem
                  icon={ShieldCheck}
                  onClick={() => {
                    setMenuOpen(false)
                    navigate('/security')
                  }}
                >
                  Security &amp; two-factor
                </MenuItem>
                {/* No link to the platform console lives here, deliberately. It
                  is a separate application with its own sign-in, and a door to
                  it inside a tenant's menu is the confusion the separation
                  exists to remove. */}
                <MenuItem icon={LogOut} danger onClick={() => signOut?.()}>
                  Sign out
                </MenuItem>
              </div>
            )}
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className={shell.mainClassName}
        >
          <HomeBar />
          <motion.div
            key={location.pathname}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          >
            {children}
          </motion.div>
        </main>

        {shell.showFieldNav && <FieldNav homePath={shell.homePath} />}

        <RequestAccessModal open={reqOpen} onClose={() => setReqOpen(false)} />
        {/* Sam the Buddy — the ISO 45001 assistant, available on every screen. */}
        <Sam />

        <IdleGuard signOut={signOut} />
      </div>
    </AlertProvider>
  )
}

function MenuItem({ icon: Icon, children, onClick, danger }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-semibold transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 ${
        danger ? 'text-red-700 hover:bg-red-50' : 'text-ink-700 hover:bg-surface-100'
      }`}
    >
      <Icon size={15} />
      {children}
    </button>
  )
}
