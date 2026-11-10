// The signed-in person's in-app notifications: inbox/<uid>/items, written by
// the server (stack/notify.mjs) under the same rules as the mail. The policy
// lets the owner mark one read or dismiss it, and nothing else; this file is
// those two writes and the live read.
import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
} from '../data/client.js'
import { db } from '../db'

// The newest hundred. Older ones are still there for a subject-access export;
// the bell is for what needs doing now.
export const INBOX_LIMIT = 100

const itemsOf = (uid) => collection(db, 'inbox', uid, 'items')

export function subscribeInbox(uid, cb, onError) {
  if (!uid) {
    cb([])
    return () => {}
  }
  return onSnapshot(
    query(itemsOf(uid), orderBy('createdAt', 'desc'), limit(INBOX_LIMIT)),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  )
}

export const markRead = (uid, id) =>
  updateDoc(doc(db, 'inbox', uid, 'items', id), { readAt: new Date().toISOString() })

export const dismiss = (uid, id) => deleteDoc(doc(db, 'inbox', uid, 'items', id))

export async function markAllRead(uid, items) {
  await Promise.all(items.filter((n) => !n.readAt).map((n) => markRead(uid, n.id)))
}

/**
 * Where a notification opens. Only a path inside this app: the item came from
 * the server, but a link that left the app from a bell would be the one place
 * a forged item could do harm, so it is checked here as well.
 */
export function safeLink(link) {
  const s = String(link || '')
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') ? s : ''
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || '')
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`
  return new Date(t).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
