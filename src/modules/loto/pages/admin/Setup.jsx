import { Link } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { SETUP_PAGES } from './setupPages'
import { PageHeader } from '../../../../shared/ui'

export default function Setup() {
  return (
    <div>
      <PageHeader
        title="LOTO set-up"
        subtitle="Registers that isolation work draws on."
        icon={Settings2}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SETUP_PAGES.map((p) => (
          <Link
            key={p.to}
            to={p.to}
            {...(p.write ? { 'data-write': true } : {})}
            className="card flex items-start gap-3 p-5 transition-colors hover:bg-surface-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <span className="grid h-10 w-10 flex-none place-items-center rounded-2xl bg-brand-50 text-brand-700">
              <p.icon size={18} aria-hidden="true" />
            </span>
            <span>
              <span className="block font-semibold text-ink-900">{p.label}</span>
              <span className="block text-sm text-ink-500">{p.hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
