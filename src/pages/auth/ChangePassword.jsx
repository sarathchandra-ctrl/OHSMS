import { useState } from 'react'
import toast from 'react-hot-toast'
import { KeyRound, LogOut } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import { Button, Field, Input } from '../../shared/ui'
import { validatePassword, passwordLengthHint } from '../../shared/auth/passwordPolicy'
import { completePasswordChange } from '../../shared/functions'
import AuthLayout from './AuthLayout'

const REASONS = {
  'current-rejected': 'Your current password is not right.',
  policy: 'Choose a different password of at least 10 characters.',
  stale: 'For safety, sign out and sign in again, then change your password straight away.',
}

/**
 * Choosing a new password. Full-screen when an administrator gave this person
 * a temporary one (profile.mustChangePassword); also used from Account
 * security. The server checks the current password and the 10-character
 * minimum; the flag is cleared there, never by the browser.
 */
export function ChangePasswordForm({ onDone }) {
  const { profile, refreshProfile } = useAuth()
  const [current, setCurrent] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const problem = validatePassword(pw, { email: profile?.email, name: profile?.name })
    if (problem) return toast.error(problem)
    if (pw !== pw2) return toast.error('The two new passwords do not match.')
    setBusy(true)
    try {
      await completePasswordChange({ current, password: pw })
      toast.success('Password changed')
      setCurrent('')
      setPw('')
      setPw2('')
      await refreshProfile()
      onDone?.()
    } catch (err) {
      toast.error(REASONS[err?.reason] || err?.message || 'The password was not changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Current password" htmlFor="current-password">
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="New password" htmlFor="new-password" hint={passwordLengthHint()}>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </Field>
      <Field label="New password again" htmlFor="new-password-2">
        <Input
          id="new-password-2"
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
  )
}

export default function ChangePassword() {
  const { signOut } = useAuth()
  return (
    <AuthLayout
      title="Choose your password"
      subtitle="Your administrator set a temporary password. Replace it to continue."
      footer={
        <button
          type="button"
          onClick={signOut}
          className="inline-flex items-center gap-1 font-semibold text-brand-700 underline-offset-2 hover:underline"
        >
          <LogOut size={14} /> Sign out
        </button>
      }
    >
      <ChangePasswordForm />
    </AuthLayout>
  )
}
