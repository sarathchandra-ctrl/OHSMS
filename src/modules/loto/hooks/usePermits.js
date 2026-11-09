import { useEffect, useState } from 'react'
import { subscribePermit, subscribePermitEvents, subscribePermits } from '../services/permits'

/** Real-time list of the current org's LOTO permits, newest first. */
export function usePermits() {
  const [permits, setPermits] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    return subscribePermits(
      (items) => {
        setPermits(items)
        setLoading(false)
      },
      () => setLoading(false),
    )
  }, [])

  return { permits, loading }
}

/** One permit, live. `permit` is null once loaded if it does not exist. */
export function usePermit(permitNo) {
  const [state, setState] = useState({ permit: undefined, loading: true })

  useEffect(() => {
    if ((!permitNo)) return undefined
    return subscribePermit(
      permitNo,
      (permit) => setState({ permit, loading: false }),
      () => setState({ permit: null, loading: false }),
    )
  }, [permitNo])

  return state
}

/** A clock that ticks once a minute so due/overdue badges move without a reload. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** The timeline of one permit, oldest first. */
export function usePermitEvents(permitNo) {
  const [events, setEvents] = useState([])
  useEffect(() => {
    if ((!permitNo)) return undefined
    return subscribePermitEvents(permitNo, setEvents, () => setEvents([]))
  }, [permitNo])
  return events
}
