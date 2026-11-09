import { useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { KeyRound } from 'lucide-react'
import { Button, Field, Input } from '../../shared/ui'
import { ownStackGateway } from '../../shared/auth/ownStackSession'
import { validatePassword, passwordLengthHint } from '../../shared/auth/passwordPolicy'
import AuthLayout from './AuthLayout'

/** The token from the emailed link's #fragment, taken once and cleared from the address bar. */
function takeToken() {
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token') || ''
  if (token) window.history.replaceState({}, '', window.location.pathname)
  return token
}

export default function ResetPassword() {
  const [token] = useState(takeToken)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const problem = validatePassword(pw)
    if (problem) return toast.error(problem)
    if (pw !== pw2) return toast.error('The two passwords do not match.')
    setBusy(true)
    try {
      const res = await fetch(`${ownStackGateway()}/auth/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: pw }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.message || 'The password was not changed.')
      setDone(true)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const back = (
    <Link to="/login" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
      Go to sign in
    </Link>
  )

  if (!token && !done) {
    return (
      <AuthLayout title="Reset password" subtitle="This link is not complete" footer={back}>
        <p className="text-sm text-ink-600">
          Open the link from the email again, or ask for a new one from the sign-in page.
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="Cult Fit SMS" footer={back}>
      {done ? (
        <p role="status" className="rounded-2xl bg-brand-50 px-4 py-3 text-sm text-brand-800">
          Your password has been changed. Sign in with the new one.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" htmlFor="reset-password" hint={passwordLengthHint()}>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              required
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </Field>
          <Field label="New password again" htmlFor="reset-password-2">
            <Input
              id="reset-password-2"
              type="password"
              autoComplete="new-password"
              required
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
            />
          </Field>
          <Button type="submit" icon={KeyRound} loading={busy} className="w-full">
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
