import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { Smartphone } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import { Button, Field, Input } from '../../shared/ui'
import {
  confirmTotpEnrollment,
  disableOwnTotp,
  startTotpEnrollment,
  totpStatus,
} from '../../shared/functions'

const REASONS = {
  code: 'That code is not right. Use the current code from your authenticator app.',
  expired: 'Setting up took too long. Start again.',
  required: 'Your administrator requires two-step login for your account.',
  locked: 'Too many wrong codes. Try again in 15 minutes.',
  'already-on': 'Two-step login is already on.',
  'not-configured': 'Two-step login is not set up on this server. Ask an administrator.',
  'not-allowed': 'Change your temporary password first.',
}

const reasonOf = (err, fallback) => REASONS[err?.reason] || err?.message || fallback
const digits = (v) => String(v || '').replace(/\s+/g, '')

function CodeInput({ id, value, onChange }) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]{6,7}"
      maxLength={7}
      required
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="123 456"
      className="tracking-[0.25em]"
    />
  )
}

/**
 * Two-step login for the signed-in person: an authenticator app (Google
 * Authenticator, Microsoft Authenticator, 1Password…) gives a 6-digit code
 * that is asked for after the password.
 *
 * The server makes and keeps the secret; this screen shows it once, as a QR
 * code and as text, and turns it on only when a code from the app proves the
 * phone has it. `onDone` runs after it is turned on.
 */
export default function TwoStepSetup({ onDone }) {
  const { profile, refreshProfile } = useAuth()
  const [enabled, setEnabled] = useState(null) // null: still asking the server
  const [unavailable, setUnavailable] = useState(false)
  const [setup, setSetup] = useState(null) // { secret, uri, qr }
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    totpStatus()
      .then((r) => live && setEnabled(Boolean(r?.enabled)))
      .catch(() => live && setUnavailable(true))
    return () => {
      live = false
    }
  }, [])

  const start = async () => {
    setBusy(true)
    try {
      const r = await startTotpEnrollment()
      const qr = await QRCode.toDataURL(r.uri, { margin: 1, width: 200 })
      setSetup({ secret: r.secret, uri: r.uri, qr })
      setCode('')
    } catch (err) {
      toast.error(reasonOf(err, 'Two-step login could not be started.'))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await confirmTotpEnrollment({ code: digits(code) })
      toast.success('Two-step login is on')
      setSetup(null)
      setEnabled(true)
      await refreshProfile()
      onDone?.()
    } catch (err) {
      if (err?.reason === 'expired') setSetup(null)
      toast.error(reasonOf(err, 'Two-step login was not turned on.'))
    } finally {
      setCode('')
      setBusy(false)
    }
  }

  const turnOff = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await disableOwnTotp({ code: digits(code) })
      toast.success('Two-step login is off')
      setEnabled(false)
      await refreshProfile()
    } catch (err) {
      toast.error(reasonOf(err, 'Two-step login was not turned off.'))
    } finally {
      setCode('')
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="two-step-title" className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-brand-500/10 text-brand-700">
          <Smartphone size={18} aria-hidden="true" />
        </span>
        <div>
          <h2 id="two-step-title" className="text-[15px] font-bold text-ink-900">
            Two-step login
          </h2>
          <p className="text-sm text-ink-500">
            After your password, enter a 6-digit code from an authenticator app on your phone.
          </p>
        </div>
      </div>

      {unavailable ? (
        <p className="text-sm text-ink-500">
          Two-step login needs this installation&apos;s server.
        </p>
      ) : enabled === null ? (
        <p className="text-sm text-ink-500">Checking…</p>
      ) : enabled ? (
        <>
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
            On. Sign-in asks for a code from your app.
          </p>
          {profile?.mfaRequired === true ? (
            <p className="text-xs text-ink-500">
              Your administrator requires it, so it cannot be turned off here. If you lose your
              phone, ask an administrator to reset it.
            </p>
          ) : (
            <form onSubmit={turnOff} className="space-y-3">
              <Field label="Current code, to turn it off" htmlFor="totp-off-code">
                <CodeInput id="totp-off-code" value={code} onChange={setCode} />
              </Field>
              <Button type="submit" variant="ghost" loading={busy}>
                Turn off
              </Button>
            </form>
          )}
        </>
      ) : setup ? (
        <form onSubmit={confirm} className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-700">
            <li>Open your authenticator app and add an account.</li>
            <li>Scan this code, or type the key below.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <img
            src={setup.qr}
            alt="QR code for your authenticator app"
            width={200}
            height={200}
            className="rounded-xl bg-white p-2 ring-1 ring-ink-900/10"
          />
          <div>
            <p className="text-xs font-semibold text-ink-500">Key</p>
            <code className="block break-all rounded-lg bg-surface-50 px-3 py-2 font-mono text-sm text-ink-900 ring-1 ring-ink-900/5">
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
          </div>
          <Field label="Code from the app" htmlFor="totp-setup-code">
            <CodeInput id="totp-setup-code" value={code} onChange={setCode} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" onClick={start} loading={busy}>
          Set up two-step login
        </Button>
      )}
    </section>
  )
}
