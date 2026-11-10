import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Activity, List, TriangleAlert, Upload } from 'lucide-react'
import { CctvProvider } from './context/CctvContext'
import Dashboard from './pages/Dashboard'
import Inventory from './pages/Inventory'
import Defects from './pages/Defects'
import BulkUpload from './pages/BulkUpload'
import ScopeBar from './components/ScopeBar'
import ModuleTabs from '../../shared/layout/ModuleTabs'

// CCTV — an inventory of cameras, DVRs and Meraki devices, and the health that
// falls out of how they are wired together. The module's whole reason for
// existing is the cascade: a camera that stops answering is usually not the
// broken thing, and reporting it as one sends technicians to the wrong place.
const TABS = [
  { to: '/cctv', end: true, label: 'Health', icon: Activity },
  { to: '/cctv/inventory', label: 'Inventory', icon: List },
  { to: '/cctv/defects', label: 'Defects', icon: TriangleAlert },
  { to: '/cctv/import', label: 'Import', icon: Upload, write: true },
]

export default function CctvModule() {
  return (
    <CctvProvider>
      <ModuleShell />
    </CctvProvider>
  )
}

/**
 * Inside the provider, so the scope bar can read it.
 *
 * The bar is hidden on Import: that page adds devices rather than reading them,
 * and a filter sitting above it would imply the import is scoped too.
 */
function ModuleShell() {
  const { pathname, search } = useLocation()
  const onImport = pathname.startsWith('/cctv/import')

  // The scope lives in the query string, so the tab links have to carry it —
  // a bare `to="/cctv/defects"` would silently drop the filter on every tab
  // change, which is the bug this whole arrangement exists to avoid.
  const keepScope = (to) => ({ pathname: to, search })

  return (
    <>
      <ModuleTabs label="CCTV sections" tabs={TABS} toFor={(to) => keepScope(to)} />

      {!onImport && <ScopeBar />}

      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="defects" element={<Defects />} />
        <Route path="import" element={<BulkUpload />} />
        <Route path="*" element={<Navigate to="/cctv" replace />} />
      </Routes>
    </>
  )
}
