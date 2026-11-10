import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import {
  Home as HomeIcon,
  ListChecks,
  ClipboardList,
  PlayCircle,
  FileSignature,
  Search,
  ScrollText,
  BookOpen,
  Settings2,
} from 'lucide-react'
import { TutorialProvider } from './context/TutorialContext'
import Home from './pages/Home'
import Inventory from './pages/procedures/Inventory'
import Register from './pages/procedures/Register'
import CreateProcedure from './pages/procedures/CreateProcedure'
import ProcedureDetail from './pages/procedures/ProcedureDetail'
import Operations from './pages/operations/Operations'
import OperateProcedure from './pages/operations/OperateProcedure'
import Permits from './pages/permits/Permits'
import NewPermit from './pages/permits/NewPermit'
import PermitDetail from './pages/permits/PermitDetail'
import Technicians from './pages/admin/Technicians'
import LockInventory from './pages/admin/LockInventory'
import ShiftTimes from './pages/admin/ShiftTimes'
import GroupNumbers from './pages/admin/GroupNumbers'
import Trace from './pages/admin/Trace'
import Activity from './pages/permits/Activity'
import ImportData from './pages/admin/ImportData'
import Setup from './pages/admin/Setup'
import { SETUP_PAGES } from './pages/admin/setupPages'
import Learn from './pages/Learn'
import ModuleTabs from '../../shared/layout/ModuleTabs'
import WriteGate from '../../shared/auth/WriteGate'

// Daily isolation work, then one Set-up tab for the registers it draws on:
// thirteen tabs ran off the screen.
const SETUP_PATHS = SETUP_PAGES.map((p) => p.to)

function tabsFor(pathname) {
  const inSetup = pathname === '/loto/setup' || SETUP_PATHS.some((p) => pathname.startsWith(p))
  return [
    { to: '/loto', label: 'Home', icon: HomeIcon, end: true },
    { to: '/loto/inventory', label: 'Procedures', icon: ListChecks },
    { to: '/loto/register', label: 'Register', icon: ClipboardList },
    { to: '/loto/operations', label: 'Operations', icon: PlayCircle },
    { to: '/loto/permits', label: 'Permits', icon: FileSignature },
    { to: '/loto/trace', label: 'Trace', icon: Search },
    { to: '/loto/activity', label: 'Activity', icon: ScrollText },
    { to: '/loto/learn', label: 'Learn', icon: BookOpen },
    { to: '/loto/setup', label: 'Set-up', icon: Settings2, active: inSetup },
  ]
}

function ModuleNav() {
  const { pathname } = useLocation()
  return <ModuleTabs label="Lockout / Tagout sections" tabs={tabsFor(pathname)} />
}

function ListLayout() {
  return (
    <>
      <ModuleNav />
      <Outlet />
    </>
  )
}

// Lockout / Tagout — Hazardous Energy Control (ported from hecp-loto), at /loto.
export default function LotoModule() {
  return (
    <TutorialProvider>
      <Routes>
        <Route element={<ListLayout />}>
          <Route index element={<Home />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="register" element={<Register />} />
          <Route path="operations" element={<Operations />} />
          <Route path="permits" element={<Permits />} />
          <Route path="setup" element={<Setup />} />
          <Route path="technicians" element={<Technicians />} />
          <Route path="locks" element={<LockInventory />} />
          <Route path="shifts" element={<ShiftTimes />} />
          <Route path="groups" element={<GroupNumbers />} />
          <Route path="trace" element={<Trace />} />
          <Route path="activity" element={<Activity />} />
          <Route path="import" element={<ImportData />} />
          <Route path="learn" element={<Learn />} />
        </Route>
        <Route path="operations/:id" element={<OperateProcedure />} />
        <Route path="permits/new" element={<WriteGate><NewPermit /></WriteGate>} />
        <Route path="permits/:id" element={<PermitDetail />} />
        <Route path="procedures/new" element={<WriteGate><CreateProcedure /></WriteGate>} />
        <Route path="procedures/:id/revise" element={<CreateProcedure />} />
        <Route path="procedures/:id" element={<ProcedureDetail />} />
        <Route path="*" element={<Navigate to="/loto" replace />} />
      </Routes>
    </TutorialProvider>
  )
}
