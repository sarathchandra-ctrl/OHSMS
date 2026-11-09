import { useEffect, useState } from 'react'
import { subscribeTechnicians } from '../services/technicians'

/** Real-time list of the current org's authorized LOTO technicians. */
export function useTechnicians() {
  const [technicians, setTechnicians] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = subscribeTechnicians(
      (items) => {
        setTechnicians(items)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return unsub
  }, [])

  return { technicians, loading }
}
