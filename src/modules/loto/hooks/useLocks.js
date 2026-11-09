import { useEffect, useState } from 'react'
import { subscribeLocks } from '../services/locks'

/** Real-time list of the current org's physical locks (the Lock Inventory). */
export function useLocks() {
  const [locks, setLocks] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = subscribeLocks(
      (items) => {
        setLocks(items)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return unsub
  }, [])

  return { locks, loading }
}
