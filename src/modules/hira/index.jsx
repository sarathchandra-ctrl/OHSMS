import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { Library, Layers, Grid3x3, ListChecks, Upload } from 'lucide-react'
import { RaProvider } from './context/RaContext'
import Repository from './pages/Repository'
import BaselineRepository from './pages/BaselineRepository'
import CreateAssessment from './pages/CreateAssessment'
import AssessmentView from './pages/AssessmentView'
import RiskRegister from './pages/RiskRegister'
import ActionTracker from './pages/ActionTracker'
import BulkImport from './pages/BulkImport'
import ModuleTabs from '../../shared/layout/ModuleTabs'
import WriteGate from '../../shared/auth/WriteGate'

const TABS = [
  { to: '/hira', label: 'Assessments', icon: Library, end: true },
  { to: '/hira/baselines', label: 'Baselines', icon: Layers },
  { to: '/hira/risk-register', label: 'Risk Register', icon: Grid3x3 },
  { to: '/hira/action-tracker', label: 'Action Tracker', icon: ListChecks },
  { to: '/hira/bulk-import', label: 'Bulk Import', icon: Upload, write: true },
]

function ModuleNav() {
  return <ModuleTabs label="Risk Assessment sections" tabs={TABS} />
}

function ListLayout() {
  return (
    <>
      <ModuleNav />
      <Outlet />
    </>
  )
}

// Hazard Identification & Risk Assessment (ported from hira), mounted at /hira.
export default function HiraModule() {
  return (
    <RaProvider>
      <Routes>
        <Route element={<ListLayout />}>
          <Route index element={<Repository />} />
          <Route path="repository" element={<Repository />} />
          <Route path="baselines" element={<BaselineRepository />} />
          <Route path="risk-register" element={<RiskRegister />} />
          <Route path="action-tracker" element={<ActionTracker />} />
          <Route path="bulk-import" element={<WriteGate><BulkImport /></WriteGate>} />
        </Route>
        <Route path="create" element={<WriteGate><CreateAssessment /></WriteGate>} />
        <Route path="create/:id" element={<CreateAssessment />} />
        <Route path="assessment/:id" element={<AssessmentView />} />
        <Route path="*" element={<Navigate to="/hira" replace />} />
      </Routes>
    </RaProvider>
  )
}
