import { ShieldCheck } from 'lucide-react'
import { PageHeader } from '../../shared/ui'
import WhatsAppLink from './WhatsAppLink'
import { ChangePasswordForm } from './ChangePassword'
import { SERVER_FEATURES } from '../../shared/serverFeatures'
import TwoStepSetup from './TwoStepSetup'
import OtherSessions from './OtherSessions'
import DailySummary from './DailySummary'

// Your own password and two-step login. Both are checked by this server; an
// administrator can set a temporary password if you forget it, and reset
// two-step login if you lose your phone (Employees → Edit).
export default function Security() {
  return (
    <>
      <PageHeader title="Account security" subtitle="Your password and two-step login" icon={ShieldCheck} />
      <div className="space-y-4">
        <div className="card max-w-md p-6">
          <ChangePasswordForm />
        </div>
        <div className="card max-w-md p-6">
          <TwoStepSetup />
        </div>
        <div className="card max-w-md p-6">
          <OtherSessions />
        </div>
        <div className="card max-w-md p-6">
          <DailySummary />
        </div>
        {SERVER_FEATURES.whatsapp && <WhatsAppLink />}
      </div>
    </>
  )
}
