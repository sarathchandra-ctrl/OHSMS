import { useEffect, useState } from 'react'
import {
  subscribeOrgEvents,
  subscribeOrgProcedures,
} from '../services/procedures'

/** Real-time list of the current org's procedures. */
export function useOrgProcedures() {
  const [procedures, setProcedures] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = subscribeOrgProcedures(
      (items) => {
        setProcedures(items)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return unsub
  }, [])

  return { procedures, loading }
}

/** Real-time append-only LOTO activity log for the current org. */
export function useOrgEvents() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = subscribeOrgEvents(
      (items) => {
        setEvents(items)
        setLoading(false)
      },
      () => setLoading(false),
    )
    return unsub
  }, [])

  return { events, loading }
}
