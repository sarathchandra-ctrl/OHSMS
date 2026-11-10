import { Link } from 'react-router-dom'
import {
  AlarmClock,
  CalendarClock,
  ClipboardList,
  ImageIcon,
  ListChecks,
  PlayCircle,
} from 'lucide-react'

const LINKS = [
  { to: '/actions', label: 'Actions', detail: 'Open actions across modules', icon: ListChecks },
  { to: '/inspections', label: 'Inspection schedule', detail: 'What is due', icon: CalendarClock },
  {
    to: '/inspections/overdue',
    label: 'Overdue inspections',
    detail: 'Past the due date',
    icon: AlarmClock,
  },
  {
    to: '/inspections/execute',
    label: 'Start an inspection',
    detail: 'A checklist, with photos',
    icon: PlayCircle,
  },
  {
    to: '/equipment/signages',
    label: 'Signage check',
    detail: 'Last checked, and a photo',
    icon: ImageIcon,
  },
  {
    to: '/inspections/forms',
    label: 'Checklists',
    detail: 'The forms those inspections use',
    icon: ClipboardList,
  },
]

export default function FieldTasks() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-[22px] font-extrabold tracking-[-0.02em] text-ink-900">My tasks</h1>
      <p className="mt-1 text-sm text-ink-500">
        Actions assigned to you, and the inspections you carry out.
      </p>
      <ul className="mt-4 grid gap-3">
        {LINKS.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              className="flex min-h-[4.5rem] items-center gap-3 rounded-3xl bg-white px-4 py-3 shadow-elev-sm ring-1 ring-ink-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <span className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-brand-50 text-brand-700">
                <item.icon size={22} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-[16px] font-bold text-ink-900">{item.label}</span>
                <span className="block text-[13px] text-ink-500">{item.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
