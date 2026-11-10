import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { subscribeInbox } from './inbox'
import { InboxContext } from './inboxContext'

export function InboxProvider({ children }) {
  const { user } = useAuth()
  const uid = user?.uid || ''
  const [items, setItems] = useState([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setReady(false)
    return subscribeInbox(
      uid,
      (rows) => {
        setItems(rows)
        setReady(true)
      },
      // A refused read (temporary password, signed out) is an empty bell,
      // not an error on every page.
      () => {
        setItems([])
        setReady(true)
      }
    )
  }, [uid])

  const value = useMemo(
    () => ({ uid, items, ready, unread: items.filter((n) => !n.readAt).length }),
    [uid, items, ready]
  )
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}
