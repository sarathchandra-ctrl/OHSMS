import { ShieldCheck } from 'lucide-react'
import { PageHeader } from '../../shared/ui'
import WhatsAppLink from './WhatsAppLink'
import { ChangePasswordForm } from './ChangePassword'
import { SERVER_FEATURES } from '../../shared/serverFeatures'

// Your own password. It is checked by this server; an administrator can set
// a temporary one if you forget it (Employees → Reset password).
export default function Security() {
  return (
    <>
      <PageHeader title="Account security" subtitle="Change your password" icon={ShieldCheck} />
      <div className="space-y-4">
        <div className="card max-w-md p-6">
          <ChangePasswordForm />
        </div>
        {SERVER_FEATURES.whatsapp && <WhatsAppLink />}
      </div>
    </>
  )
}
