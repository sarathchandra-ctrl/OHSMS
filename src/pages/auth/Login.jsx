import { useState } from 'react'
import { useLocation, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ShieldCheck } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import { authErrorMessage } from '../../shared/lib/authErrors'
import { Button, Field, Input } from '../../shared/ui'
import { safeInternalPath } from '../../shared/safeUrl'
import AuthLayout from './AuthLayout'
import LoginModules from './LoginModules'
import { ownStackAuthMethod } from '../../shared/auth/ownStackSession'

// One organization, one sign-in: whatever identity provider was connected at
// /setup on this server. There is no registration and no "join an
// organization" here — people are invited by an administrator, or join
// through the domain / group rules an administrator set (stack/invites.mjs).
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

  const method = ownStackAuthMethod()

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const result = await login(form)
      if (result?.status === 'signed-in') toast.success('Welcome back')
    } catch (err) {
      toast.error(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // Before /setup has connected an identity provider there is nobody who can
  // sign in. A password form here would ask for a password nothing checks.
  if (!['oidc', 'saml', 'supabase'].includes(method)) {
    return (
      <AuthLayout
        title="Not set up yet"
        subtitle="Occupational Health & Safety Management System"
        showcase={<LoginModules />}
      >
        <p className="text-sm leading-relaxed text-ink-600">
          This server is waiting for your organization&apos;s sign-in to be connected. Sign-in
          opens here once that is done.
        </p>
        {/* A full page load, not a route: /setup is served by the server, not this app. */}
        <Button as="a" href="/setup" icon={ShieldCheck} className="mt-5 w-full">
          Set up this server
        </Button>
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          For whoever installed it. You will need the setup code from the server&apos;s settings.
        </p>
      </AuthLayout>
    )
  }

  if (method === 'oidc' || method === 'saml') {
    return (
      <AuthLayout
        title="Sign in"
        subtitle="Occupational Health & Safety Management System"
        showcase={<LoginModules />}
      >
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-600">
            Your organization signs in with its own identity provider. You will be taken to your
            company&apos;s sign-in page and brought back here.
          </p>
          <Button type="submit" icon={ShieldCheck} loading={busy} className="w-full">
            Continue with company sign-in
          </Button>
        </form>
      </AuthLayout>
    )
  }

  // Supabase Auth: email and password, checked by the Supabase project the
  // server was connected to — never by this page.
  return (
    <AuthLayout
      title="Sign in"
      subtitle="Occupational Health & Safety Management System"
      showcase={<LoginModules />}
      footer={
        <span className="block">
          <a
            href="/privacy"
            className="font-semibold text-brand-700 underline-offset-2 hover:underline"
          >
            Privacy Policy
          </a>
          {' · '}
          <a href="/terms" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
            Terms of Use
          </a>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="you@company.com"
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
