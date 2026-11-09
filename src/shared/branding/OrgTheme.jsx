// ─────────────────────────────────────────────────────────────────────────────
// Apply the organization's theme to the document.
//
// AuthProvider already holds the live org document, so this sits next to the
// rest of the tree and rewrites `--canvas` / `--brand-*` whenever that
// snapshot (or the resolved logo) changes. Login and the platform console
// have no org — the kit defaults in index.css stay.
//
// A stored theme whose canvasSource is `logo` or `custom` wins. Sampling is
// how a mark gets its colours in the first place, and how an upload that
// persisted the kit hexes (the decoder failed, and those hexes were then
// treated as final) still tints the chrome. The sample prefers a same-origin
// thumb or blob: an https download URL taints the canvas when the bucket has
// no CORS rule, and that failure used to leave the amber kit in place.
//
// Members cannot write the org document. The sampled colours are painted for
// everyone immediately; an admin's session writes them once so the next load
// does not depend on decoding the logo again.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef } from 'react'
import { useAuth } from '../auth/AuthContext'
import { updateOrgSettings } from '../org/orgData'
import { reportError } from '../monitoring'
import { useFileUrl } from '../storage/useFileUrl'
import { hasOrgLogo } from './OrgMark'
import {
  DEFAULT_ACCENT,
  DEFAULT_CANVAS,
  applyOrgTheme,
  extractPaletteFromSrc,
  paletteFromLogo,
  readTheme,
  sampleSrcForLogo,
  shouldSampleLogo,
  themePatchForLogo,
  themeTokens,
} from './theme'

export default function OrgTheme() {
  const { org, isAdmin, actor } = useAuth()
  const { src, loading } = useFileUrl({ url: org?.logoUrl, path: org?.logoPath })
  const actorUid = actor?.uid || ''
  const actorName = actor?.name || ''
  const healed = useRef('')

  useEffect(() => {
    if (!org) {
      applyOrgTheme(null)
      return undefined
    }

    const stored = readTheme(org.theme)
    let cancelled = false

    const paint = (accent, canvas) => {
      if (cancelled) return
      // Kit defaults already live in :root. Rewriting them with a generated
      // scale from the same teal is how `.btn-soft` dropped to 4.46:1 — the
      // baked brand-700 is darker than mix(solid, black, 0.18).
      const a = accent || DEFAULT_ACCENT
      const c = canvas || DEFAULT_CANVAS
      if (a.toLowerCase() === DEFAULT_ACCENT && c.toLowerCase() === DEFAULT_CANVAS) {
        applyOrgTheme(null)
        return
      }
      applyOrgTheme(themeTokens({ accent: a, canvas: c }))
    }

    const sample = shouldSampleLogo(org.theme, hasOrgLogo(org))
    if (!sample) {
      paint(stored.accent, stored.canvas)
      return () => {
        cancelled = true
      }
    }

    const sampleSrc = sampleSrcForLogo(org.logoUrl, src)
    if (!sampleSrc) {
      // Bytes not here yet. Don't wipe a theme the fetch is about to supply.
      if (!loading) paint(stored.accent, stored.canvas)
      return () => {
        cancelled = true
      }
    }

    extractPaletteFromSrc(sampleSrc)
      .then((palette) => {
        if (cancelled) return
        const derived = paletteFromLogo(palette)
        if (!derived) {
          paint(stored.accent, stored.canvas)
          return
        }
        paint(derived.accent, derived.canvas)
        const theme = themePatchForLogo(org.theme, palette)
        if (!theme || !isAdmin || !actorUid) return
        const key = `${org.logoPath || ''}|${org.logoUrl || ''}`
        if (healed.current === key) return
        healed.current = key
        updateOrgSettings({ theme }, { uid: actorUid, name: actorName || 'Unknown' }).catch(
          (err) => {
            healed.current = ''
            reportError(err, { source: 'branding.persistLogoTheme' })
          }
        )
      })
      .catch(() => {
        // CORS, a broken blob, a 1×1 pixel — keep whatever was already stored.
        if (!cancelled) paint(stored.accent, stored.canvas)
      })

    return () => {
      cancelled = true
    }
  }, [org, src, loading, isAdmin, actorUid, actorName])

  return null
}
