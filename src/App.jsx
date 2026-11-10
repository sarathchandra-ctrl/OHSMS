import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { isAppConfigured } from './shared/appConfigured'
import ProtectedRoute from './shared/auth/ProtectedRoute'
import ModuleGate from './shared/modules/ModuleGate'
const AppChrome = lazy(() => import('./shared/layout/AppChrome'))
import ModuleLoading from './shared/layout/ModuleLoading'
import SamLoading from './shared/layout/SamLoading'
import ErrorBoundary from './shared/ErrorBoundary'

// Public QR landing for equipment labels — no auth, so it stays outside the shell.
const QrLanding = lazy(() => import('./modules/fire/pages/QrLanding'))
const PublicPermit = lazy(() => import('./modules/ptw/pages/PublicPermit'))

// Public / auth pages (eager — small, first paint).
import SetupNeeded from './pages/SetupNeeded'
import Login from './pages/auth/Login'
import ForgotPassword from './pages/auth/ForgotPassword'
import ResetPassword from './pages/auth/ResetPassword'
import PendingApproval from './pages/auth/PendingApproval'
import NotFound from './pages/NotFound'

// App pages.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Security = lazy(() => import('./pages/auth/Security'))
const Users = lazy(() => import('./pages/admin/Users'))
const Sites = lazy(() => import('./pages/admin/Sites'))
const OrgSettings = lazy(() => import('./pages/admin/OrgSettings'))
const Notifications = lazy(() => import('./pages/Notifications'))
const AuditLog = lazy(() => import('./pages/admin/AuditLog'))
const Maintenance = lazy(() => import('./pages/admin/Maintenance'))

// The platform console — which modules each ORGANIZATION may use.
//

// Modules (lazy — several pull heavy libs like react-flow / three / xlsx).
const Incidents = lazy(() => import('./modules/incidents'))
const Hira = lazy(() => import('./modules/hira'))
const Inspections = lazy(() => import('./modules/inspections'))
const Audit = lazy(() => import('./modules/audit'))
const Permits = lazy(() => import('./modules/ptw'))
const Loto = lazy(() => import('./modules/loto'))
const Equipment = lazy(() => import('./modules/fire'))
const Drills = lazy(() => import('./modules/fire/DrillsModule'))
const Committee = lazy(() => import('./modules/committee'))
const Training = lazy(() => import('./modules/training'))
const Documents = lazy(() => import('./modules/documents'))
const Actions = lazy(() => import('./modules/actions'))
const Emergency = lazy(() => import('./modules/emergency'))
const Objectives = lazy(() => import('./modules/objectives'))
const Weather = lazy(() => import('./modules/weather'))
const Cctv = lazy(() => import('./modules/cctv'))
const Stakeholder = lazy(() => import('./modules/stakeholder'))
// Side-effect import: registers CCTV's site-created hook eagerly, so a site
// added by someone who never opens the CCTV tab still gets its Meraki.
import './modules/cctv/registerHooks'

// Employee portal — brings its own shell, so it is not wrapped in AppChrome.
const Portal = lazy(() => import('./pages/portal'))
const Field = lazy(() => import('./pages/field'))
const Analytics = lazy(() => import('./pages/analytics'))

// The public read-only view of a scanned LOTO procedure. Lazy like the other
// public QR landings — it is reached from a printed code, not from the app.
const PublicProcedure = lazy(() => import('./modules/loto/pages/PublicProcedure'))

/**
 * The target of a tag scanned at an isolation point.
 *
 * Goes to the OPERATION, not the procedure. The procedure is the instruction
 * set; someone standing at a locked valve wants the live state of this
 * particular point, and the operation page is the only thing that carries it.
 *
 * The point travels as a hash so the page can bring it into view without the
 * route needing to know anything about how that page is laid out.
 */
function TagScanRedirect() {
  const { id, point } = useParams()
  return <Navigate to={`/loto/operations/${id}#point-${point}`} replace />
}

/**
 * `moduleKey` names the registry module a route belongs to, and mounting it
 * behind ModuleGate is what stops a bookmark reaching a module the organization
 * has not been given. Routes without one — the dashboard, admin screens, the
 * portal — are part of the product every tenant has.
 */
function Protected({ children, moduleKey, ...guard }) {
  return (
    <ProtectedRoute {...guard}>
      <Suspense fallback={<SamLoading />}>
      <AppChrome>
        <ErrorBoundary>
          <Suspense fallback={<ModuleLoading />}>
            {moduleKey ? <ModuleGate moduleKey={moduleKey}>{children}</ModuleGate> : children}
          </Suspense>
        </ErrorBoundary>
      </AppChrome>
      </Suspense>
    </ProtectedRoute>
  )
}

export default function App() {
  // Dev-only crash switch so the root ErrorBoundary stays verifiable: append
  // ?__crash=1 to any URL in dev and the recovery screen must appear. Compiled
  // out of production builds by the DEV guard.
  if (import.meta.env.DEV && window.location.search.includes('__crash=1')) {
    throw new Error('Deliberate test crash (?__crash=1)')
  }

  // Without a backend, only the setup screen can render (appConfigured.js).
  if (!isAppConfigured()) {
    return (
      <Suspense fallback={<SamLoading />}>
        <Routes>
          <Route path="*" element={<SetupNeeded />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      {/* Scanned from a printed extinguisher label — deliberately public. */}
      <Route path="/qr/:token" element={<ErrorBoundary><Suspense fallback={<SamLoading />}><QrLanding /></Suspense></ErrorBoundary>} />
      {/* The QR printed on every work permit. Public: whoever scans a permit
          taped to a scaffold has no account. */}
      <Route path="/permit/:token" element={<ErrorBoundary><Suspense fallback={<SamLoading />}><PublicPermit /></Suspense></ErrorBoundary>} />
      <Route path="/pending" element={<PendingApproval />} />

      {/* The QR printed on a LOTO isolation procedure. It has always encoded
          `/p/<id>` (procedureScanUrl), and until now nothing served that path —
          every scan fell through to the catch-all, so the codes on the machines
          led nowhere.

          A redirect rather than a renamed URL, because those codes are printed
          and stuck to equipment: changing the generator would orphan every one
          already in the field. The short path is also the better QR — fewer
          characters means a less dense code, which matters when it is being
          scanned off a dirty machine in bad light.

          Public, and read-only. It used to redirect into the protected app, so
          scanning a code on a machine showed a login screen to the person least
          able to do anything about it — a fitter at the equipment, mid-shift,
          with no account. It now serves a reference view: what to isolate, how,
          the hazard, how to verify it dead, and whether each point is locked
          right now. No controls. Locking a point still requires signing in.

          It reads a public MIRROR (/procedureQr), never the procedure document,
          because rules cannot restrict which fields a read returns and the
          procedure carries the names of the people who locked it. */}
      <Route path="/p/:id" element={<ErrorBoundary><Suspense fallback={<SamLoading />}><PublicProcedure /></Suspense></ErrorBoundary>} />

      {/* The tag hung at an isolation point. Opens the live operation rather
          than the procedure: a tag is printed when the lock goes on and can
          outlive the job, so pointing at live state is what stops a stale tag
          claiming a machine is still isolated. */}
      <Route path="/t/:id/:point" element={<TagScanRedirect />} />

      {/* Employee portal. Signed in like everything else, but outside AppShell:
          the admin sidebar is the thing this surface exists to replace. */}
      <Route
        path="/portal/*"
        element={
          <ProtectedRoute>
            <Suspense fallback={<SamLoading />}><Portal /></Suspense>
          </ProtectedRoute>
        }
      />

      {/* App. /hub was the old home; the portal replaced it and carries the same
          module grid plus the workspace tiles, so old links land there. */}
      <Route path="/hub" element={<Navigate to="/portal" replace />} />
      <Route path="/field/*" element={<Protected><Field /></Protected>} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/security" element={<Protected><Security /></Protected>} />
      <Route path="/notifications" element={<Protected><Notifications /></Protected>} />
      <Route path="/incidents/*" element={<Protected moduleKey="incidents"><Incidents /></Protected>} />
      <Route path="/hira/*" element={<Protected moduleKey="hira"><Hira /></Protected>} />
      <Route path="/inspections/*" element={<Protected moduleKey="inspections"><Inspections /></Protected>} />
      <Route path="/audit/*" element={<Protected moduleKey="audit"><Audit /></Protected>} />
      <Route path="/permits/*" element={<Protected moduleKey="ptw"><Permits /></Protected>} />
      <Route path="/loto/*" element={<Protected moduleKey="loto"><Loto /></Protected>} />
      <Route path="/equipment/*" element={<Protected moduleKey="equipment"><Equipment /></Protected>} />
      <Route path="/mock-drills/*" element={<Protected moduleKey="drills"><Drills /></Protected>} />
      <Route path="/committee/*" element={<Protected moduleKey="committee"><Committee /></Protected>} />
      <Route path="/training/*" element={<Protected moduleKey="training"><Training /></Protected>} />
      <Route path="/documents/*" element={<Protected moduleKey="documents"><Documents /></Protected>} />
      <Route path="/actions/*" element={<Protected moduleKey="actions"><Actions /></Protected>} />
      <Route path="/emergency-response/*" element={<Protected moduleKey="emergency"><Emergency /></Protected>} />
      <Route path="/objectives/*" element={<Protected moduleKey="objectives"><Objectives /></Protected>} />
      <Route path="/weather/*" element={<Protected moduleKey="weather"><Weather /></Protected>} />
      <Route path="/cctv/*" element={<Protected moduleKey="cctv"><Cctv /></Protected>} />
      <Route path="/stakeholder/*" element={<Protected moduleKey="stakeholder"><Stakeholder /></Protected>} />

      {/* Administration */}
      <Route path="/analytics" element={<Protected><Analytics /></Protected>} />
      <Route path="/sites" element={<Protected requireCap="record.view"><Sites /></Protected>} />
      <Route path="/audit-log" element={<Protected requireCap="audit.view"><AuditLog /></Protected>} />
      <Route path="/maintenance" element={<Protected requireCap="org.settings"><Maintenance /></Protected>} />
      <Route path="/users" element={<Protected requireAdmin><Users /></Protected>} />
      <Route path="/settings" element={<Protected requireAdmin><OrgSettings /></Protected>} />

      {/* Fallbacks */}
      {/* The portal is everyone's home. Anyone with a role above plain member
          gets to the modules from the Personal / Organization switch. */}
      <Route path="/" element={<Navigate to="/portal" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
