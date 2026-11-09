import { useState } from 'react'
import { Link, useLocation, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../shared/auth/AuthContext'
import { authErrorMessage } from '../../shared/lib/authErrors'
import { Button, Field, Input } from '../../shared/ui'
import { safeInternalPath } from '../../shared/safeUrl'
import AuthLayout from './AuthLayout'
import LoginModules from './LoginModules'

// Email and password, checked by this installation's server. People are added
// by an administrator (Employees → Add employee); there is no self-sign-up.
export default function Login() {
  const { login, isAuthed, profile } = useAuth()
  const location = useLocation()
  const [form, setForm] = useState({ email: '', password: '' })
  const [busy, setBusy] = useState(false)

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
      await login(form)
      toast.success('Welcome back')
    } catch (err) {
      toast.error(authErrorMessage(err))
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
              href="/privacy"
              className="font-semibold text-brand-700 underline-offset-2 hover:underline"
            >
              Privacy Policy
            </a>
            {' · '}
            <a
              href="/terms"
              className="font-semibold text-brand-700 underline-offset-2 hover:underline"
            >
              Terms of Use
            </a>
          </span>
        </span>
      }
    >
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
    </AuthLayout>
  )
}
