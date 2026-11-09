import { lazy, Suspense } from 'react'
import ModuleLoading from '../../shared/layout/ModuleLoading'
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { LayoutDashboard, Boxes, Wrench, Stamp, MapPin, Trash2 } from 'lucide-react'
import { FleetProvider } from './context/FleetContext'
import EquipmentHub from './EquipmentHub'
const EquipmentRepository = lazy(() => import('./EquipmentRepository'))
const DefectRepository = lazy(() => import('./DefectRepository'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Repository = lazy(() => import('./pages/Repository'))
const Signages = lazy(() => import('./pages/Signages'))
const LinkedSites = lazy(() => import('./pages/LinkedSites'))
const AEDRepository = lazy(() => import('./pages/AEDRepository'))
const AEDDashboard = lazy(() => import('./pages/AEDDashboard'))
const FASRepository = lazy(() => import('./pages/FASRepository'))
const FASPanel = lazy(() => import('./pages/FASPanel'))
const FASDashboard = lazy(() => import('./pages/FASDashboard'))
const SignageDashboard = lazy(() => import('./pages/SignageDashboard'))
const Stretchers = lazy(() => import('./pages/Stretchers'))
const StretcherDashboard = lazy(() => import('./pages/StretcherDashboard'))
const FirstAid = lazy(() => import('./pages/FirstAid'))
const FirstAidDashboard = lazy(() => import('./pages/FirstAidDashboard'))
const AssetBulkUpload = lazy(() => import('./pages/AssetBulkUpload'))
const AssetsDue = lazy(() => import('./pages/AssetsDue'))
const AddExtinguisher = lazy(() => import('./pages/AddExtinguisher'))
const BulkUpload = lazy(() => import('./pages/BulkUpload'))
const QRPrint = lazy(() => import('./pages/QRPrint'))
const RefillDue = lazy(() => import('./pages/RefillDue'))
const InProcess = lazy(() => import('./pages/InProcess'))
const PhysicalDefects = lazy(() => import('./pages/PhysicalDefects'))
const PhysicalDefectLog = lazy(() => import('./pages/PhysicalDefectLog'))
const Closed = lazy(() => import('./pages/Closed'))
const Approvals = lazy(() => import('./pages/Approvals'))
const RecycleBin = lazy(() => import('./pages/RecycleBin'))
import ModuleTabs from '../../shared/layout/ModuleTabs'
import {
  RECYCLE_BIN_PATH,
  BinCountBadge,
  useRecycleBinEntry,
} from './components/RecentlyDeletedLink'

// Dashboard = per-type dashboards (EquipmentHub tabs, kept separate).
// Repository = one consolidated inventory for every equipment class.
// Defects    = one common defect repository, closeable from there.
const TABS = [
  { to: '/equipment', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/equipment/repository', label: 'Repository', icon: Boxes },
  { to: '/equipment/defects', label: 'Defects', icon: Wrench },
  { to: '/equipment/sites', label: 'Sites', icon: MapPin },
  { to: '/equipment/approvals', label: 'Approvals', icon: Stamp },
]

function ModuleNav() {
  // Org admins, and managers with a site/region/entity grant. Members do not
  // delete, so they have nothing to restore. The route still exists; the rules
  // are what refuse the write. Each register's header carries the same link,
  // because this strip scrolls sideways and its last pill is off-screen on a
  // phone.
  const { visible, count } = useRecycleBinEntry()
  const tabs = visible
    ? [
        ...TABS,
        {
          to: RECYCLE_BIN_PATH,
          label: (
            <>
              Recently deleted
              <BinCountBadge count={count} />
            </>
          ),
          icon: Trash2,
        },
      ]
    : TABS
  return <ModuleTabs label="Emergency Equipment sections" tabs={tabs} />
}

function ListLayout() {
  return (
    <>
      <ModuleNav />
      <Outlet />
    </>
  )
}

// Emergency Equipment Inventory (from fire-marshal): fire extinguishers, AED,
// fire-alarm systems, signages, stretchers, first aid boxes and their
// inspection/approval lifecycle. Mounted at /equipment. Mock Drills is now a
// separate module (see DrillsModule).
export default function EquipmentModule() {
  return (
    <FleetProvider>
      <Suspense fallback={<ModuleLoading />}>
      <Routes>
        <Route element={<ListLayout />}>
          <Route index element={<EquipmentHub />} />
          <Route path="dashboard" element={<EquipmentHub />} />
          <Route path="ext-dashboard" element={<Dashboard />} />
          <Route path="repository" element={<EquipmentRepository />} />
          <Route path="extinguishers" element={<Repository />} />
          <Route path="defects" element={<DefectRepository />} />
          <Route path="signages" element={<Signages />} />
          <Route path="signage-dashboard" element={<SignageDashboard />} />
          <Route path="sites" element={<LinkedSites />} />
          <Route path="aed" element={<AEDRepository />} />
          <Route path="aed-dashboard" element={<AEDDashboard />} />
          <Route path="fas" element={<FASRepository />} />
          <Route path="fas/:id" element={<FASPanel />} />
          <Route path="fas-dashboard" element={<FASDashboard />} />
          <Route path="stretchers" element={<Stretchers />} />
          <Route path="stretcher-dashboard" element={<StretcherDashboard />} />
          <Route path="first-aid" element={<FirstAid />} />
          <Route path="first-aid-dashboard" element={<FirstAidDashboard />} />
          <Route path="assets-due" element={<AssetsDue />} />
          <Route path="refill-due" element={<RefillDue />} />
          <Route path="in-process" element={<InProcess />} />
          <Route path="physical-defects" element={<PhysicalDefects />} />
          <Route path="physical-open" element={<PhysicalDefectLog mode="open" />} />
          <Route path="physical-closed" element={<PhysicalDefectLog mode="closed" />} />
          <Route path="closed" element={<Closed />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="recycle" element={<RecycleBin />} />
        </Route>
        <Route path="add" element={<AddExtinguisher />} />
        <Route path="bulk-upload" element={<BulkUpload />} />
        <Route path="asset-bulk-upload" element={<AssetBulkUpload />} />
        <Route path="qr-print" element={<QRPrint />} />
        <Route path="*" element={<Navigate to="/equipment" replace />} />
      </Routes>
      </Suspense>
    </FleetProvider>
  )
}
