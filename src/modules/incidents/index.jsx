import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { IncidentProvider } from './context/IncidentContext'
import ErrorBoundary from '../../shared/ErrorBoundary'
import ModuleNav from './ModuleNav'
import Incidents from './pages/Incidents'
import IncidentWizard from './pages/IncidentWizard'
import Illnesses from './pages/Illnesses'
import IllnessWizard from './pages/IllnessWizard'
import Injuries from './pages/Injuries'
import ActionTracker from './pages/ActionTracker'
import RecycleBin from './pages/RecycleBin'
import WriteGate from '../../shared/auth/WriteGate'

// List pages share the secondary tab nav; the wizards render full-width.
function ListLayout() {
  return (
    <>
      <ModuleNav />
      <Outlet />
    </>
  )
}

// Incident Reporting & Analysis (ported from incident-ira), mounted at /incidents
// inside the shared app shell. IncidentProvider holds the org's real-time data.
export default function IncidentsModule() {
  return (
    <ErrorBoundary>
      <IncidentProvider>
        <Routes>
          <Route element={<ListLayout />}>
            <Route index element={<Incidents />} />
            <Route path="illness" element={<Illnesses />} />
            <Route path="injuries" element={<Injuries />} />
            <Route path="actions" element={<ActionTracker />} />
            <Route path="recycle" element={<RecycleBin />} />
          </Route>
          <Route path="new" element={<WriteGate><IncidentWizard /></WriteGate>} />
          <Route path=":id" element={<IncidentWizard />} />
          <Route path="illness/new" element={<WriteGate><IllnessWizard /></WriteGate>} />
          <Route path="illness/:id" element={<IllnessWizard />} />
          <Route path="*" element={<Navigate to="/incidents" replace />} />
        </Routes>
      </IncidentProvider>
    </ErrorBoundary>
  )
}
