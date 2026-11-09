import { PlugZap } from 'lucide-react'
import BrandMark from '../shared/branding/BrandMark'

// Shown when the app cannot find its organization's server: the Cloudflare
// Worker has no ORIGIN_URL yet, the Tunnel is down, or a local build has no
// VITE_DATA_GATEWAY. docs/CLOUDFLARE.md is the procedure.
export default function SetupNeeded() {
  return (
    <div className="aurora grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandMark className="mb-3" alt="Cult Fit SMS" />
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-ink-900">Not connected yet</h1>
          <p className="mt-1 text-sm text-ink-500">Occupational Health &amp; Safety Management System</p>
        </div>
        <div className="card space-y-4 p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700 ring-1 ring-brand-200/70">
              <PlugZap size={20} />
            </span>
            <div>
              <h2 className="font-semibold text-ink-900">This site cannot reach its server</h2>
              <p className="mt-1 text-sm text-ink-500">
                The app is published, but your organization&apos;s server is not connected to it yet,
                or is not answering right now. Please try again later.
              </p>
            </div>
          </div>
          <p className="text-xs text-ink-400">
            For whoever installs it: start the server and its Cloudflare Tunnel, then set{' '}
            <span className="font-mono">ORIGIN_URL</span> on the Worker (docs/CLOUDFLARE.md).
          </p>
        </div>
      </div>
    </div>
  )
}
