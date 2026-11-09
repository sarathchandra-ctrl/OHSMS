// Per-site shift clocks. organizations/{orgId}/lotoSettings/shifts.
// Admin writes; every approved member can read. The permit rules read the
// same document when they decide whether a window is that site's shift.
import { doc, onSnapshot, serverTimestamp, setDoc } from '../../../shared/data/client.js'
import { db } from '../../../shared/db'

export const SHIFT_SETTINGS_ID = 'shifts'

const ref = () => doc(db, 'lotoSettings', SHIFT_SETTINGS_ID)

export function subscribeShiftSettings(cb) {
  return onSnapshot(
    ref(),
    (snap) => cb(snap.exists() ? snap.data() : null),
    () => cb(null),
  )
}

/**
 * Replace one site's shifts inside the settings document. `current` is the
 * document already loaded, so saving site A does not wipe site B.
 */
export async function saveSiteShifts({ user, siteId, shifts, zoneOffsetMinutes, current }) {
  const sites = { ...(current?.sites || {}) }
  const map = {}
  for (const s of shifts) {
    const id = String(s.id || '').trim()
    if (!id) continue
    map[id] = {
      start: s.start,
      end: s.end,
      label: String(s.label || id).slice(0, 80),
    }
  }
  sites[siteId] = {
    zoneOffsetMinutes: Number.isInteger(zoneOffsetMinutes) ? zoneOffsetMinutes : 0,
    shifts: map,
  }
  await setDoc(ref(), {
    sites,
    updatedAt: serverTimestamp(),
    updatedBy: user.id,
  })
}
