import { useCallback, useEffect, useState } from 'react'
import { doc, setDoc } from '../../../shared/data/client.js'
import { db } from '../../../shared/db'
import { useAuth } from '../../../shared/auth/AuthContext'
import { normalizeSelection } from './catalog'

/**
 * Which widgets this person has chosen.
 *
 * Stored on their own user document, so it follows them between devices rather
 * than living in one browser's local storage — the phone on site and the
 * desktop in the office should show the same portal.
 *
 * Saving is optimistic. The grid re-renders from local state immediately and
 * the write follows; a failed write leaves the choice applied for the session
 * rather than snapping the layout back while someone is still picking.
 */
export function useWidgetPrefs() {
  const { user, profile } = useAuth()
  const stored = profile?.portalWidgets

  const [keys, setKeys] = useState(() => normalizeSelection(stored))

  // Follow the profile when it arrives or changes elsewhere, but not while the
  // two already agree — otherwise every profile snapshot would clobber a
  // selection the user is part-way through making.
  useEffect(() => {
    const next = normalizeSelection(stored)
    setKeys((prev) => (sameOrder(prev, next) ? prev : next))
  }, [stored])

  const save = useCallback(async (next) => {
    const clean = normalizeSelection(next)
    setKeys(clean)
    if (!user?.uid) return
    try {
      await setDoc(doc(db, 'users', user.uid), { portalWidgets: clean }, { merge: true })
    } catch {
      // Keeping the choice for this session is better than reverting under
      // someone mid-edit; it will be re-applied next time they save.
    }
  }, [user?.uid])

  return { keys, save }
}

const sameOrder = (a, b) => a.length === b.length && a.every((k, i) => k === b[i])
