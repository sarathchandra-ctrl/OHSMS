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
registerShellWorker()
dismissBootSplash()

createRoot(document.getElementById('root')).render(
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
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
        <AuthProvider>
          <OrgTheme />
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
)

