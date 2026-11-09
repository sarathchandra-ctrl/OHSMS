import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail } from 'lucide-react'
import { Button, Field, Input } from '../../shared/ui'
import { ownStackGateway } from '../../shared/auth/ownStackSession'
import AuthLayout from './AuthLayout'

// Asks the server to email a one-time reset link. The answer is the same
// whether or not the address has an account (stack/passwords.mjs).
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch(`${ownStackGateway()}/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = await res.json().catch(() => ({}))
      setMessage(body.message || 'Something went wrong. Please try again.')
    } catch {
      setMessage('This site cannot reach its server right now. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Forgot password"
      subtitle="We will email you a link to choose a new one"
      footer={
        <Link to="/login" className="font-semibold text-brand-700 underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {message ? (
        <p role="status" className="rounded-2xl bg-brand-50 px-4 py-3 text-sm text-brand-800">
          {message}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Work email" htmlFor="forgot-email">
            <Input
              id="forgot-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="text-base sm:text-sm"
            />
          </Field>
          <Button type="submit" icon={Mail} loading={busy} className="w-full">
            Email me a reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
