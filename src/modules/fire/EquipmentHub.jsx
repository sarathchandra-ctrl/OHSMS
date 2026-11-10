import { lazy, Suspense, useState } from 'react'
import ModuleLoading from '../../shared/layout/ModuleLoading'
import { Link } from 'react-router-dom'
import {
  Flame,
  HeartPulse,
  BellRing,
  Signpost,
  Ambulance,
  BriefcaseMedical,
  Plus,
} from 'lucide-react'
import Dashboard from './pages/Dashboard'
const AEDDashboard = lazy(() => import('./pages/AEDDashboard'))
const FASDashboard = lazy(() => import('./pages/FASDashboard'))
const SignageDashboard = lazy(() => import('./pages/SignageDashboard'))
const StretcherDashboard = lazy(() => import('./pages/StretcherDashboard'))
const FirstAidDashboard = lazy(() => import('./pages/FirstAidDashboard'))

// One dashboard for all emergency equipment — each type in its own tab, keeping
// the existing per-equipment dashboard designs. Signage and first aid sit
// beside them: their records live in the Repository, but their coverage reads
// like the rest.
const TABS = [
  { key: 'ext', label: 'Extinguishers', icon: Flame, Comp: Dashboard },
  { key: 'aed', label: 'AED', icon: HeartPulse, Comp: AEDDashboard },
  { key: 'fas', label: 'Fire Alarm', icon: BellRing, Comp: FASDashboard },
  { key: 'signage', label: 'Signage', icon: Signpost, Comp: SignageDashboard },
  { key: 'stretcher', label: 'Stretchers', icon: Ambulance, Comp: StretcherDashboard },
  { key: 'firstaid', label: 'First Aid', icon: BriefcaseMedical, Comp: FirstAidDashboard },
]

export default function EquipmentHub() {
  const [tab, setTab] = useState('ext')
  const Active = (TABS.find((t) => t.key === tab) || TABS[0]).Comp

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="tab-strip min-w-0 flex-1" role="tablist" aria-label="Equipment dashboards">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              role="tab"
              aria-selected={tab === t.key}
              className={`nav-tab ${tab === t.key ? 'nav-tab-active' : 'nav-tab-idle'}`}
            >
              <t.icon size={16} /> {t.label}
            </button>
          ))}
        </div>
        <Link data-write to="/equipment/add" className="btn-primary !py-1.5 text-xs">
          <Plus size={14} /> Add extinguisher
        </Link>
      </div>

      <Suspense fallback={<ModuleLoading />}><Active /></Suspense>
    </div>
  )
}
