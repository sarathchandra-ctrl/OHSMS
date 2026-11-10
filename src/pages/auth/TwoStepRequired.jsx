import { LogOut } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import AuthLayout from './AuthLayout'
import TwoStepSetup from './TwoStepSetup'

/**
 * Full screen while an administrator requires two-step login and this person
 * has not set it up. The server holds the account to its own profile until
 * then (accountGated in stack/lib/accountGate.js), so this is the only screen
 * that would work anyway.
 */
export default function TwoStepRequired() {
  const { signOut } = useAuth()
  return (
    <AuthLayout
      title="Set up two-step login"
      subtitle="Your administrator requires it before you continue"
      footer={
        <button
          type="button"
          onClick={signOut}
          className="inline-flex items-center gap-1 font-semibold text-brand-700 underline-offset-2 hover:underline"
        >
          <LogOut size={14} aria-hidden="true" /> Sign out
        </button>
      }
    >
      <TwoStepSetup />
    </AuthLayout>
  )
}
