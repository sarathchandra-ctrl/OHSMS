import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { FileCheck, Stamp, Eye } from 'lucide-react'
import { PermitProvider } from './context/PermitContext'
import Permits from './pages/Permits'
import PermitForm from './pages/PermitForm'
import PermitDetail from './pages/PermitDetail'
import Approvals from './pages/Approvals'
import Observations from './pages/Observations'
import ModuleTabs from '../../shared/layout/ModuleTabs'
import WriteGate from '../../shared/auth/WriteGate'

const TABS = [
  { to: '/permits', label: 'Permits', icon: FileCheck, end: true },
  { to: '/permits/approvals', label: 'Approvals', icon: Stamp, write: true },
  { to: '/permits/observations', label: 'Observations', icon: Eye },
]

function ModuleNav() {
  return <ModuleTabs label="Permit to Work sections" tabs={TABS} />
}

function ListLayout() {
  return (
    <>
      <ModuleNav />
      <Outlet />
    </>
  )
}

// Permit to Work (ported from permit-to-work), mounted at /permits.
export default function PermitsModule() {
  return (
    <PermitProvider>
      <Routes>
        <Route element={<ListLayout />}>
          <Route index element={<Permits />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="observations" element={<Observations />} />
        </Route>
        <Route path="new" element={<WriteGate><PermitForm /></WriteGate>} />
        <Route path=":id" element={<PermitDetail />} />
        <Route path="*" element={<Navigate to="/permits" replace />} />
      </Routes>
    </PermitProvider>
  )
}
