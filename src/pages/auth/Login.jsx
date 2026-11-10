import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../shared/auth/AuthContext'
import { authErrorMessage } from '../../shared/lib/authErrors'
import { Button, Field, Input } from '../../shared/ui'
import { safeInternalPath } from '../../shared/safeUrl'
import AuthLayout from './AuthLayout'
import LoginModules from './LoginModules'
import { publicPath } from '../../shared/publicPath'

// Email and password, checked by this installation's server. People are added
// by an administrator (Employees → Add employee); there is no self-sign-up.
export default function Login() {
  const { login, loginWithCode, isAuthed, profile } = useAuth()
  const location = useLocation()
  const [form, setForm] = useState({ email: '', password: '' })
  const [busy, setBusy] = useState(false)
  // Set once the password is right and two-step login is on: the server's
  // short-lived ticket for the code step. Never stored; a reload starts over.
  const [ticket, setTicket] = useState(null)
  const [code, setCode] = useState('')
  const codeRef = useRef(null)
  // The password field the person was typing in is gone; move them to the
  // field that replaced it rather than leaving focus on nothing.
  useEffect(() => {
    if (ticket) codeRef.current?.focus()
  }, [ticket])

  // Where ProtectedRoute bounced us from. safeInternalPath because this is an
  // open-redirect sink followed at the moment the user has proved who they are.
  const back = safeInternalPath(location.state?.from?.pathname, '/portal')

  // Only redirect once the profile has loaded — redirecting on isAuthed alone
  // races ProtectedRoute (which needs the profile) and causes a redirect loop.
  if (isAuthed && profile) return <Navigate to={back} replace />

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const result = await login(form)
      if (result.status === 'code') {
        setTicket(result.ticket)
        setCode('')
        return
      }
      toast.success('Welcome back')
    } catch (err) {
      toast.error(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await loginWithCode({ ticket, code: code.replace(/\s+/g, '') })
      toast.success('Welcome back')
    } catch (err) {
      // A spent or expired ticket cannot take another code: back to the password.
      if (err?.code !== 'code') {
        setTicket(null)
        setForm((f) => ({ ...f, password: '' }))
      }
      setCode('')
      toast.error(err?.message || authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Cult Fit Safety Management System"
      showcase={<LoginModules />}
      footer={
        <span className="block">
          <Link
            to="/forgot-password"
            className="font-semibold text-brand-700 underline-offset-2 hover:underline"
          >
            Forgot password?
          </Link>
          <span className="mt-2 block">
            <a
              href={publicPath('/privacy')}
              className="font-semibold text-brand-700 underline-offset-2 hover:underline"
            >
              Privacy Policy
            </a>
            {' · '}
            <a
              href={publicPath('/terms')}
              className="font-semibold text-brand-700 underline-offset-2 hover:underline"
            >
              Terms of Use
            </a>
          </span>
        </span>
      }
    >
      {ticket ? (
        <form onSubmit={submitCode} className="space-y-4">
          <p className="text-sm text-ink-600">
            Enter the 6-digit code from your authenticator app for <b>{form.email}</b>.
          </p>
          <Field label="Code" htmlFor="totp-code">
            <Input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
              required
              ref={codeRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123 456"
              className="text-center text-lg tracking-[0.3em]"
            />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            Verify
          </Button>
          <button
            type="button"
            onClick={() => {
              setTicket(null)
              setForm((f) => ({ ...f, password: '' }))
            }}
            className="w-full rounded text-sm font-semibold text-brand-700 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            Use a different account
          </button>
          <p className="text-xs text-ink-500">
            Lost your phone? An administrator can reset two-step login for you.
          </p>
        </form>
      ) : (
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="you@curefit.com"
            className="text-base sm:text-sm"
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="••••••••"
            className="text-base sm:text-sm"
          />
        </Field>
        <Button type="submit" loading={busy} className="w-full">
          Sign in
        </Button>
      </form>
      )}
    </AuthLayout>
  )
}
