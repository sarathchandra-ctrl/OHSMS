import { useState } from 'react'
import toast from 'react-hot-toast'
import { updateDoc } from '../../shared/data/client.js'
import { userRef } from '../../shared/org/orgData'
import { useAuth } from '../../shared/auth/AuthContext'
import { toastCaught } from '../../shared/lib/toastCaught'

// Your own choice about the morning summary email. The organization decides
// whether it is sent at all (Admin → Organization settings → Notifications);
// this is one person stepping out of it. `digestOptOut` is not a privileged
// field: it touches no one's access but the writer's own inbox.
export default function DailySummary() {
  const { user, profile } = useAuth()
  const [optOut, setOptOut] = useState(profile?.digestOptOut === true)
  const [busy, setBusy] = useState(false)
  if (!user?.uid) return null

  const change = async (wanted) => {
    setBusy(true)
    try {
      await updateDoc(userRef(user.uid), { digestOptOut: !wanted })
      setOptOut(!wanted)
      toast.success(wanted ? 'You will get the daily summary' : 'Daily summary switched off')
    } catch (err) {
      toastCaught(err, 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h3 className="font-semibold text-ink-800">Daily summary email</h3>
      <p className="mb-3 mt-1 text-sm text-ink-500">
        Each morning, what is due or overdue for you: your corrective actions, training and audits,
        and for a manager what is due at your sites. Not sent on a day with nothing to say.
      </p>
      <label htmlFor="digest-opt" className="flex cursor-pointer items-center gap-3 text-sm text-ink-800">
        <input
          id="digest-opt"
          type="checkbox"
          role="switch"
          className="h-4 w-4"
          checked={!optOut}
          disabled={busy}
          onChange={(e) => change(e.target.checked)}
        />
        Send me the daily summary
      </label>
    </div>
  )
}
