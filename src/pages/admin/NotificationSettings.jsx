import { useState } from 'react'
import toast from 'react-hot-toast'
import { Bell } from 'lucide-react'
import { Card } from '../../shared/ui'
import { toastCaught } from '../../shared/lib/toastCaught'
import { runtimeEnv } from '../../shared/runtimeConfig'
import { updateOrgSettings } from '../../shared/org/orgData'
import { sendDigestsNow } from '../../shared/functions'
import { NOTIFY_KINDS, notifySettings } from '../../../stack/lib/notify.js'

// Which mail the server sends, one switch per kind, grouped by module. Saved
// the moment a switch moves rather than on the form's Save: subscribeOrg
// rewrites the General form on every snapshot, and a switch that sprang back
// after someone else's edit would look like it never took. The server reads
// the same `notifications` map (stack/lib/notify.js notifySettings), where a
// kind never saved counts as on.
export default function NotificationSettings({ org, actor }) {
  const [busy, setBusy] = useState('')
  const on = notifySettings(org)
  const mailOn = runtimeEnv('RESET_BY_EMAIL') === 'on'
  const modules = [...new Set(NOTIFY_KINDS.map((k) => k.module))]

  const flip = async (key, value) => {
    setBusy(key)
    try {
      await updateOrgSettings({ notifications: { ...on, [key]: value } }, actor)
      toast.success(value ? 'Notification switched on' : 'Notification switched off')
    } catch (err) {
      toastCaught(err, 'Could not save')
    } finally {
      setBusy('')
    }
  }

  // Each person still gets at most one summary a day (stack/notify.mjs), so
  // this cannot double the morning run; it is for checking a new set-up.
  const sendNow = async () => {
    setBusy('send')
    try {
      const r = await sendDigestsNow()
      if (r?.skipped === 'off') toast('The daily summary is switched off')
      else
        toast.success(
          `Sent ${r?.sent || 0}; ${r?.already || 0} already had today’s; ${r?.nothing || 0} had nothing due`
        )
    } catch (err) {
      toastCaught(err, 'Could not send')
    } finally {
      setBusy('')
    }
  }

  return (
    <Card>
      <h3 className="flex items-center gap-2 font-semibold text-ink-800">
        <Bell size={17} className="text-brand-600" /> Notifications
      </h3>
      <p className="mb-4 mt-1 text-sm text-ink-500">
        What people are told when something needs them: in the bell at the top of every page, and by
        email. Every notification is on until you switch it off. Each carries a reference, a site, a
        date and a link — never an incident narrative, an action’s text or anything medical.
      </p>
      {!mailOn && (
        <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Outgoing mail is not configured on this server, so notifications appear in the bell only.
          These choices apply to email too once it is.
        </p>
      )}
      <div className="space-y-4">
        {modules.map((m) => (
          <fieldset key={m}>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              {m}
            </legend>
            <div className="space-y-2">
              {NOTIFY_KINDS.filter((k) => k.module === m).map((k) => (
                <label
                  key={k.key}
                  htmlFor={`notify-${k.key}`}
                  className="flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2 hover:bg-surface-100"
                >
                  <input
                    id={`notify-${k.key}`}
                    type="checkbox"
                    role="switch"
                    className="mt-0.5 h-4 w-4"
                    checked={on[k.key]}
                    disabled={busy === k.key}
                    onChange={(e) => flip(k.key, e.target.checked)}
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink-800">{k.label}</span>
                    <span className="block text-xs text-ink-500">{k.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      {mailOn && on.digest && (
        <button
          type="button"
          className="btn-soft mt-4"
          disabled={busy === 'send'}
          onClick={sendNow}
        >
          Send today’s summaries now
        </button>
      )}
    </Card>
  )
}
