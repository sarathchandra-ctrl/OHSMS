import { HardHat, Lock, Boxes, Upload } from 'lucide-react'

// The pages that set LOTO up, rather than carry out isolation. They were
// five more tabs in a row of thirteen that ran off the screen, mixed in
// with the daily work.
export const SETUP_PAGES = [
  {
    to: '/loto/technicians',
    label: 'Technicians',
    hint: 'Authorised technicians, licences and personal locks',
    icon: HardHat,
  },
  { to: '/loto/locks', label: 'Locks', hint: 'Department padlocks, tags and colours', icon: Lock },
  { to: '/loto/groups', label: 'Group numbers', hint: 'Group lock box numbers', icon: Boxes },
  {
    to: '/loto/import',
    label: 'Import',
    hint: 'Equipment, locks, group numbers and technicians from CSV',
    icon: Upload,
    write: true,
  },
]
