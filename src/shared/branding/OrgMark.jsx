// ─────────────────────────────────────────────────────────────────────────────
// Whose product is this?
//
// The organization using the app owns the top-left corner — that is the
// identity a person recognises before they read anything. An organization that
// has not uploaded a logo falls back to the Cult Fit logo, because an empty box
// is worse than a stand-in. The vendor mark is not pinned to the viewport:
// a "Powered by" badge in the corner competed with the page and was not the
// identity the header is for.
//
// Both the header and the breadcrumb read this component, so "which logo"
// cannot drift between them.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { safeSrc } from '../safeUrl'
import { inlineImageSrc, useFileUrl } from '../storage/useFileUrl'

/** The Cult Fit logo, in /public/brand. Also the fallback identity when none is set. */
export const WE_EHS_MARK = '/brand/logo.svg'

/**
 * True when the org document points at a logo.
 *
 * Uploads after audit finding M-5 no longer mint a permanent download URL, so
 * a freshly set logo often has `logoPath` and an empty `logoUrl`. Treating
 * only `logoUrl` as "has a logo" is how the header kept showing the default logo after a
 * successful upload, and how Org Settings offered "Upload" for a logo that
 * was already stored.
 */
export function hasOrgLogo(org) {
  return Boolean(org?.logoPath || org?.logoUrl)
}

/**
 * The organization's logo, or the WE EHS mark when none is set.
 *
 * `alt` defaults to empty because both call sites sit inside a link that is
 * already named ("WEHS home", "Home") — announcing the mark as well would make
 * the link read twice. Pass one only where the image stands alone.
 */
export function OrgMark({ className = '', alt = '' }) {
  const { org } = useAuth()
  const customSet = hasOrgLogo(org)
  // Resolved by PATH. Uploads no longer mint a permanent download URL (audit
  // finding M-5), so `logoPath` is what a logo set after that change carries;
  // the hook falls back to `logoUrl` for the ones set before it, and for the
  // small inline thumb Org Settings now writes alongside every path so the
  // header still has something when Storage is briefly unreachable.
  const { src, loading } = useFileUrl({ url: org?.logoUrl, path: org?.logoPath })
  // safeSrc, not the raw field: this URL comes out of a Firestore document that
  // an org admin writes, and an <img src> is fetched without anyone clicking.
  // The inline thumb is read here as well as from the hook so a path fetch
  // that has not settled — or that handed back a download URL the browser
  // will not paint — cannot blank a logo that is already on the org document.
  const inline = safeSrc(inlineImageSrc(org?.logoUrl))
  const resolved = safeSrc(src)
  const [dead, setDead] = useState({})
  useEffect(() => {
    setDead({})
  }, [resolved, inline])
  // Same-origin bytes first. A download URL is last: it is the src that
  // resolves from Storage and then 403s, and putting it ahead of the thumb
  // is how the header went blank after a successful upload.
  const sameOrigin = resolved && (resolved.startsWith('blob:') || resolved.startsWith('data:'))
  const candidates = [
    sameOrigin ? resolved : '',
    inline && inline !== resolved ? inline : '',
    !sameOrigin ? resolved : '',
  ]
  const custom = candidates.find((u) => u && !dead[u])
  const imgRef = useRef(null)
  // `error` is not a click. A download URL can 403 after getDownloadURL
  // resolved; dropping that src lets the next candidate (the inline thumb)
  // paint instead of a broken image that never comes back. Bound in an
  // effect because the a11y lint treats an onError prop on <img> as an
  // interaction on a non-interactive element.
  useEffect(() => {
    const el = imgRef.current
    if (!el || !custom) return undefined
    const onErr = () => setDead((d) => (d[custom] ? d : { ...d, [custom]: true }))
    el.addEventListener('error', onErr)
    return () => el.removeEventListener('error', onErr)
  }, [custom])

  // A logo is configured but not yet on screen. Keep a cream slot rather than
  // flashing (or settling on) the vendor mark — that swap is what made a
  // successful upload look like it had been ignored. Covers both "still
  // resolving" and "fetch failed, no thumb to fall back to".
  if (customSet && !custom) {
    return (
      <span
        aria-hidden="true"
        title={loading ? undefined : 'Organization logo unavailable'}
        className={`flex-none bg-ink-50 ${className}`}
      />
    )
  }

  return (
    <img
      ref={imgRef}
      src={custom || WE_EHS_MARK}
      alt={alt}
      aria-hidden={alt ? undefined : 'true'}
      // object-contain, not cover: a logo is a shape someone approved, and
      // cropping it to fill a square is the one thing a brand guideline never
      // permits. Cream ground, not white: the header is frosted white glass,
      // and a white fill there is how a light logo disappeared into the bar.
      className={`flex-none object-contain p-0.5 ${custom ? 'bg-ink-50' : ''} ${className}`}
    />
  )
}
