import { format, formatDistanceToNow, isValid, differenceInCalendarDays } from 'date-fns'

// Firestore Timestamp | Date | number | ISO string → Date | null
export function toDate(value) {
  if (!value) return null
  if (typeof value?.toDate === 'function') return value.toDate() // Firestore Timestamp
  if (value instanceof Date) return value
  // A bare YYYY-MM-DD (incident dates, due dates) is a calendar day. new
  // Date() reads it as UTC midnight, which is the previous day west of UTC.
  const day = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
  const d = new Date(value)
  return isValid(d) ? d : null
}

export function formatDate(value, fmt = 'd MMM yyyy') {
  const d = toDate(value)
  return d ? format(d, fmt) : '—'
}

export function formatDateTime(value) {
  const d = toDate(value)
  return d ? format(d, 'd MMM yyyy, HH:mm') : '—'
}

export function fromNow(value) {
  const d = toDate(value)
  return d ? formatDistanceToNow(d, { addSuffix: true }) : '—'
}

// Days until (positive) / since (negative) a date — for expiry & due-date logic.
export function daysUntil(value) {
  const d = toDate(value)
  return d ? differenceInCalendarDays(d, new Date()) : null
}

export function isOverdue(value) {
  const n = daysUntil(value)
  return n != null && n < 0
}

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
}
