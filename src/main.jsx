import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import ErrorBoundary from './shared/ErrorBoundary'
import { installMonitoring } from './shared/monitoring'
import { registerShellWorker } from './shared/mobile/registerSw'
import { dismissBootSplash } from './shared/mobile/bootSplash'
import { AuthProvider } from './shared/auth/AuthContext'
import OrgTheme from './shared/branding/OrgTheme'
import DemoRibbon from './demo/DemoRibbon'
// Fonts and Leaflet stay JS imports. Tailwind's PostCSS plugin treats a later
// @import as a statement it will not resolve, and the woff urls never ship.
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import '@fontsource/roboto/900.css'
import '@fontsource/open-sans/400.css'
import '@fontsource/open-sans/500.css'
import '@fontsource/open-sans/600.css'
import '@fontsource/open-sans/700.css'
import '@fontsource/open-sans/800.css'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import './index.css'

installMonitoring()
// No service worker in the Pages demo: it would cache a shell under the
// repository's sub-path and outlive the demo's in-memory data.
if (import.meta.env.VITE_DEMO !== '1') registerShellWorker()
dismissBootSplash()

// The demo answers sign-in and seeds invented data before the first render,
// so the first screen already has something to show. Loaded only in a demo
// build: a normal build never contains the demo code path.
// The check is written out, not the DEMO constant, so Vite folds it to
// `false` and a normal build drops the import and the demo data with it.
const ready =
  import.meta.env.VITE_DEMO === '1'
    ? import('./demo/startDemo').then((m) => m.startDemo())
    : Promise.resolve()

ready.then(() => createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Outermost on purpose: a crash in the router or auth provider must still
        land on the recovery screen, not a blank page. */}
    <ErrorBoundary>
      {/* Those two flags are the React Router 7 default, and BrowserRouter
          no longer accepts them. v7_relativeSplatPath only changes how a
          RELATIVE path resolves inside a splat route. This app has no relative
          <Link to> and no relative navigate() — every module's tabs are
          absolute ('/loto/inventory'), and the only relative navigation is
          navigate(-1), which is history. */}
      {/* BASE_URL is '/' normally, '/<repo>/' for the GitHub Pages demo. */}
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
        <AuthProvider>
          <OrgTheme />
          {import.meta.env.VITE_DEMO === '1' && <DemoRibbon />}
          <App />
          <Toaster
            position="top-center"
            toastOptions={{
              duration: 3500,
              className:
                '!bg-surface/90 !text-ink-800 !shadow-elev-lg !rounded-full !ring-1 !ring-ink-200 !backdrop-blur-xl',
              success: { iconTheme: { primary: '#8fbc74', secondary: '#faf3ea' } },
            }}
          />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
))

