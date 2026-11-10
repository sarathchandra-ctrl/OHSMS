// Mobile view and desktop view are two modes. A stylesheet breakpoint used to
// decide, so a phone could not open the portal and a desktop could not open
// the phone home.
//
// The first visit has no stored choice, so the device decides. A stored
// choice wins after that, including inside the native app: mobile there is
// the default, and the switch on the home screen is how a person leaves it.
// The choice lives in localStorage rather than on the profile because the
// phone and the office PC are supposed to be able to differ, and a profile
// field would need rules for something that is not a permission.
//
// index.html reads VIEW_MODE_KEY before the bundle, to skip the phone splash
// when this device has chosen the desktop portal. Those two copies have to
// stay the same string; the HTML cannot import this module.

export const VIEW_MODE_KEY = 'ohsms.viewMode'

// A large tablet is a desktop. Portrait iPads sit under this and fall
// through to the phone home; landscape ones clear it.
const TABLET_DESKTOP_MIN = 1024
// The old field bar started below Tailwind's `md`. A laptop window in that
// gap is still a desktop: only a phone-shaped window, a phone user agent,
// or a coarse pointer falls through to the phone home.
const PHONE_WINDOW_MAX = 768

export function isPhoneUserAgent(ua) {
  const s = String(ua || '')
  // iPad and Android tablets include "Mobile". Width judges those.
  if (/iPad|Tablet/i.test(s)) return false
  return /iPhone|iPod|Android.+Mobile|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(s)
}

/**
 * Which home a device gets before anyone has chosen.
 * @returns {'mobile'|'desktop'}
 */
export function automaticViewMode({
  native = false,
  width = null,
  phoneUa = false,
  coarsePointer = false,
} = {}) {
  if (native) return 'mobile'
  if (typeof width === 'number' && width >= TABLET_DESKTOP_MIN) return 'desktop'
  if (phoneUa || coarsePointer) return 'mobile'
  if (typeof width === 'number' && width < PHONE_WINDOW_MAX) return 'mobile'
  return 'desktop'
}

/** A stored mobile or desktop choice wins. Anything else is automatic. */
export function resolveViewMode(choice, signals) {
  if (choice === 'mobile' || choice === 'desktop') return choice
  return automaticViewMode(signals)
}

export function readViewChoice(storage) {
  try {
    const box = storage || globalThis.localStorage
    const value = box.getItem(VIEW_MODE_KEY)
    return value === 'mobile' || value === 'desktop' ? value : 'auto'
  } catch {
    // Private mode throws. Automatic still runs.
    return 'auto'
  }
}

export function writeViewChoice(choice, storage) {
  try {
    const box = storage || globalThis.localStorage
    if (choice === 'mobile' || choice === 'desktop') box.setItem(VIEW_MODE_KEY, choice)
    else if (choice === 'auto') box.removeItem(VIEW_MODE_KEY)
  } catch {
    // Private mode throws. The in-memory choice still changes for this tab.
  }
}

export function readSignals(win) {
  const target = win || (typeof window === 'undefined' ? undefined : window)
  if (!target) {
    return { native: false, width: null, phoneUa: false, coarsePointer: false }
  }
  let coarsePointer = false
  try {
    coarsePointer = target.matchMedia?.('(pointer: coarse)')?.matches === true
  } catch {
    coarsePointer = false
  }
  let native = false
  try {
    native = target.Capacitor?.isNativePlatform?.() === true
  } catch {
    native = false
  }
  const width = typeof target.innerWidth === 'number' ? target.innerWidth : null
  return {
    native,
    width,
    phoneUa: isPhoneUserAgent(target.navigator?.userAgent || ''),
    coarsePointer,
  }
}

/** Chrome that follows the mode: logo target, field bar, alert listeners, pad. */
export function shellForMode(mode) {
  const mobile = mode === 'mobile'
  const pad = mobile ? 'pb-[calc(6.5rem+env(safe-area-inset-bottom))]' : 'pb-24'
  return {
    homePath: mobile ? '/field' : '/portal',
    showFieldNav: mobile,
    listenForAlerts: mobile,
    mainClassName: `mx-auto max-w-[1180px] px-4 ${pad} pt-6 sm:px-7`,
  }
}

function stripTrailingSlash(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
}

/**
 * Whether the phone bar's Home control is the page on screen.
 *
 * The shell home is /field on a phone and /portal on a desktop. Sign-in still
 * opens /portal, and while this bar is mounted (mobile view only) that index
 * renders the same grid as /field. Treating only /field as home left the
 * control looking idle on the screen people actually land on. Nested portal
 * routes are not home: /portal/training is its own page.
 */
export function isShellHome(pathname, homePath) {
  const path = stripTrailingSlash(pathname)
  const home = stripTrailingSlash(homePath)
  if (!path || !home) return false
  if (path === home) return true
  if (home === '/field' && (path === '/portal' || path === '/')) return true
  return false
}

// Desktop mode has no phone home. /field would keep showing the grid, and
// that path is what the installed icon opens, so a desktop choice leaves it.
export function destinationForMode(mode, pathname) {
  if (mode === 'desktop' && typeof pathname === 'string' && pathname.startsWith('/field')) {
    return '/portal'
  }
  return null
}
