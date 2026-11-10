import { useState } from 'react'
import toast from 'react-hot-toast'
import { MonitorSmartphone } from 'lucide-react'
import { Button } from '../../shared/ui'
import { signOutOtherSessions } from '../../shared/functions'

/**
 * Sign out every other device. For a session left open on a shared machine,
 * or a phone that went missing: the server ends every token issued before
 * now, and this tab continues on a fresh one.
 */
export default function OtherSessions() {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await signOutOtherSessions()
      toast.success('Signed out on every other device')
    } catch (err) {
      toast.error(err?.message || 'Other devices were not signed out.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby="other-sessions-title" className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-brand-500/10 text-brand-700">
          <MonitorSmartphone size={18} aria-hidden="true" />
        </span>
        <div>
          <h2 id="other-sessions-title" className="text-[15px] font-bold text-ink-900">
            Other devices
          </h2>
          <p className="text-sm text-ink-500">
            Changing your password or two-step login already signs out everywhere else.
          </p>
        </div>
      </div>
      <Button type="button" variant="ghost" onClick={run} loading={busy}>
        Sign out other devices
      </Button>
    </section>
  )
}
