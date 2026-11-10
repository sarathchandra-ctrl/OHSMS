import {
  AlertTriangle,
  Bell,
  CalendarClock,
  ClipboardCheck,
  CloudSun,
  FileSearch,
  FireExtinguisher,
  Gauge,
  GraduationCap,
  ListChecks,
  Microscope,
  ShieldAlert,
  Siren,
  Users,
  Wrench,
} from 'lucide-react'

// How each kind of notification (stack/lib/notify.js NOTIFY_KINDS) looks in
// the bell: the module it belongs to, and an icon.
export const KIND_LOOK = {
  incident: { module: 'Incidents', icon: AlertTriangle, tone: 'text-red-600 bg-red-50' },
  action: { module: 'Incidents', icon: ListChecks, tone: 'text-amber-700 bg-amber-50' },
  rca: { module: 'Incidents', icon: Microscope, tone: 'text-red-700 bg-red-50' },
  hiraBaseline: {
    module: 'Risk Assessment',
    icon: ShieldAlert,
    tone: 'text-orange-700 bg-orange-50',
  },
  hiraSite: { module: 'Risk Assessment', icon: ShieldAlert, tone: 'text-orange-700 bg-orange-50' },
  hiraReview: {
    module: 'Risk Assessment',
    icon: CalendarClock,
    tone: 'text-orange-700 bg-orange-50',
  },
  defect: { module: 'Emergency Equipment', icon: Wrench, tone: 'text-red-700 bg-red-50' },
  equipmentDue: {
    module: 'Emergency Equipment',
    icon: FireExtinguisher,
    tone: 'text-amber-700 bg-amber-50',
  },
  uptime: { module: 'Emergency Equipment', icon: Gauge, tone: 'text-teal-700 bg-teal-50' },
  drill: { module: 'Mock Drills', icon: Siren, tone: 'text-rose-700 bg-rose-50' },
  drillAction: { module: 'Mock Drills', icon: ListChecks, tone: 'text-rose-700 bg-rose-50' },
  meeting: { module: 'HSE Committee', icon: Users, tone: 'text-indigo-700 bg-indigo-50' },
  meetingAction: {
    module: 'HSE Committee',
    icon: ListChecks,
    tone: 'text-indigo-700 bg-indigo-50',
  },
  weather: { module: 'Weather', icon: CloudSun, tone: 'text-sky-700 bg-sky-50' },
  permit: { module: 'Permit to Work', icon: ClipboardCheck, tone: 'text-sky-700 bg-sky-50' },
  permitStatus: { module: 'Permit to Work', icon: ClipboardCheck, tone: 'text-sky-700 bg-sky-50' },
  audit: { module: 'Internal Audit', icon: FileSearch, tone: 'text-emerald-700 bg-emerald-50' },
  training: { module: 'Training', icon: GraduationCap, tone: 'text-violet-700 bg-violet-50' },
}
export const lookOf = (kind) =>
  KIND_LOOK[kind] || { module: 'Notification', icon: Bell, tone: 'text-ink-600 bg-ink-50' }
