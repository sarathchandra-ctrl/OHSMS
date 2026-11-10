import {
  AlertTriangle,
  Bell,
  ClipboardCheck,
  FileSearch,
  GraduationCap,
  ListChecks,
} from 'lucide-react'

// How each kind of notification (stack/lib/notify.js NOTIFY_KINDS) looks in
// the bell: the module it opens, and that module's icon.
export const KIND_LOOK = {
  incident: { module: 'Incidents', icon: AlertTriangle, tone: 'text-red-600 bg-red-50' },
  action: { module: 'Incidents', icon: ListChecks, tone: 'text-amber-700 bg-amber-50' },
  permit: { module: 'Permit to Work', icon: ClipboardCheck, tone: 'text-sky-700 bg-sky-50' },
  audit: { module: 'Internal Audit', icon: FileSearch, tone: 'text-emerald-700 bg-emerald-50' },
  training: { module: 'Training', icon: GraduationCap, tone: 'text-violet-700 bg-violet-50' },
}
export const lookOf = (kind) =>
  KIND_LOOK[kind] || { module: 'Notification', icon: Bell, tone: 'text-ink-600 bg-ink-50' }
