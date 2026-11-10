import { useState } from 'react'
import { Link, useLocation, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../shared/auth/AuthContext'
import { authErrorMessage } from '../../shared/lib/authErrors'
import { Button, Field, Input } from '../../shared/ui'
import { safeInternalPath } from '../../shared/safeUrl'
import AuthLayout from './AuthLayout'
import LoginModules from './LoginModules'
import { publicPath } from '../../shared/publicPath'
import { DEMO_ACCOUNTS } from '../../demo/demoMode'

// Email and password, checked by this installation's server. People are added
// by an administrator (Employees → Add employee); there is no self-sign-up.
/** The demo build's sign-in help: invented accounts, one click to fill. */
function DemoAccounts({ onPick }) {
  return (
    <div className="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
      <p className="font-semibold">Demo — sample data that stays in your browser</p>
      <p className="mt-0.5 text-xs">Pick an account to fill the form, then sign in.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {DEMO_ACCOUNTS.map((a) => (
          <button
            key={a.uid}
            type="button"
            onClick={() => onPick(a)}
            className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {a.role === 'member' ? 'Employee' : a.role === 'manager' ? 'Manager' : 'Admin'}
          </button>
        ))}
      </div>
    </div>
  )
}

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
      {/* Written out so a normal build folds it away with the demo accounts. */}
      {import.meta.env.VITE_DEMO === '1' && <DemoAccounts onPick={(a) => setForm({ email: a.email, password: a.password })} />}
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
