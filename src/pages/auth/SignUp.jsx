// ─────────────────────────────────────────────────────────────────────────────
// /signup — the first person on a new installation creates the administrator
// account and names the organization. Everyone after them is invited by an
// administrator (Employees → Add employee). The server decides whether this
// is open (stack/passwords.mjs firstSignUp): once anyone has an account it
// is closed for good, and this page says so instead of showing the form.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../shared/auth/AuthContext'
import { Button, Field, Input } from '../../shared/ui'
import { firstSignUp, setupStatus } from '../../shared/functions'
import { authErrorMessage } from '../../shared/lib/authErrors'
import AuthLayout from './AuthLayout'

const REASONS = {
  closed: 'This system already has its administrator. Ask them to add you under Employees.',
  'setup-code': 'That setup code is not right.',
  email: 'Enter a valid email address.',
  name: 'Enter your name.',
  org: 'Enter your organization’s name.',
  policy: 'Choose a password of at least 10 characters.',
}

export default function SignUp() {
  const { login, isAuthed, profile } = useAuth()
  const [status, setStatus] = useState(null) // null loading
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '', confirm: '', code: '' })
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    let live = true
    setupStatus().then((s) => live && setStatus(s), () => live && setStatus({ open: false }))
    return () => { live = false }
  }, [])

  // Just created: straight to Employees, to invite the team.
  if (isAuthed && profile) return <Navigate to={created ? '/users' : '/portal'} replace />

  const submit = async (e) => {
    e.preventDefault()
    if (form.password !== form.confirm) return toast.error('The two passwords do not match')
    setBusy(true)
    try {
      await firstSignUp(form)
      setCreated(true)
      await login({ email: form.email, password: form.password })
      toast.success('Your organization is set up. Add your team under Employees.')
    } catch (err) {
      toast.error(REASONS[err?.reason] || authErrorMessage(err))
      if (err?.reason === 'closed') setStatus({ open: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Set up your organization"
      subtitle="Create the first account. You become the administrator and invite everyone else."
      footer={<Link to="/login" className="font-semibold text-brand-700 underline-offset-2 hover:underline">Back to sign in</Link>}
    >
      {status === null ? (
        <p className="text-sm text-ink-500">Checking…</p>
      ) : !status.open ? (
        <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">{REASONS.closed}</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Organization name"><Input required value={form.orgName} onChange={set('orgName')} autoComplete="organization" /></Field>
          <Field label="Your name"><Input required value={form.name} onChange={set('name')} autoComplete="name" /></Field>
          <Field label="Email"><Input required type="email" value={form.email} onChange={set('email')} autoComplete="email" /></Field>
          <Field label="Password" hint="At least 10 characters.">
            <Input required type="password" minLength={10} value={form.password} onChange={set('password')} autoComplete="new-password" />
          </Field>
          <Field label="Confirm password">
            <Input required type="password" minLength={10} value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
          </Field>
          {status.needsCode && (
            <Field label="Setup code" hint="Set by whoever deployed this system (SETUP_CODE).">
              <Input required value={form.code} onChange={set('code')} autoComplete="off" />
            </Field>
          )}
          <Button type="submit" className="w-full" loading={busy} disabled={busy}>Create account</Button>
        </form>
      )}
    </AuthLayout>
  )
}
