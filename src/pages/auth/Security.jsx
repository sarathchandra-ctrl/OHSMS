import { ShieldCheck } from 'lucide-react'
import { PageHeader } from '../../shared/ui'
import WhatsAppLink from './WhatsAppLink'

// Sign-in security — passwords, two-factor, lockout — belongs to the identity
// provider connected at /setup (company OIDC, SAML or Supabase Auth). This
// server keeps no passwords and so offers no second factor of its own.
export default function Security() {
  return (
    <>
      <PageHeader
        title="Account security"
        subtitle="Sign-in is managed by your organization's identity provider"
        icon={ShieldCheck}
      />
      <div className="space-y-4">
        <p className="rounded-2xl bg-surface px-4 py-3 text-sm text-ink-600">
          You sign in with your company account. Password changes and two-factor authentication
          are set up with your company&apos;s identity provider, not here. Ask your IT team if you
          need to change them.
        </p>
        <WhatsAppLink />
      </div>
    </>
  )
}
