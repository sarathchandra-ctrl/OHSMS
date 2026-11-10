// ─────────────────────────────────────────────────────────────────────────────
// The route half of module entitlements.
//
// Hiding a tile is presentation. This is the part that matters: a bookmark, a
// link in an old email, or a typed URL must not walk into a module the
// organization has not been given. The server stops the data leaving, but
// an unguarded route would still mount the module and show its empty shell with
// a permission error behind it — which reads as a broken product rather than an
// absent one.
//
// A screen, not a redirect. Someone who followed a link to /loto deserves to be
// told the module is not switched on for their organization; being bounced to
// the home page with no explanation is how a person concludes the link is
// broken and asks IT to fix nothing.
// ─────────────────────────────────────────────────────────────────────────────
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { MODULE_BY_KEY } from './registry'
import ModuleLoading from '../layout/ModuleLoading'
import { AccessDenied, Button } from '../ui'

export default function ModuleGate({ moduleKey, children }) {
  const { moduleEnabled, orgModuleEnabled, modulesReady } = useAuth()

  // Entitlements default to "everything on", so rendering the module while the
  // document is still in flight would flash it into view and then take it away.
  // The wait is a single document read against a warm connection.
  if (!modulesReady) return <ModuleLoading />
  if (moduleEnabled(moduleKey)) return children

  const mod = MODULE_BY_KEY[moduleKey]

  // The organization has the module; this person has not been given it.
  // Different cause, different person to ask.
  if (orgModuleEnabled(moduleKey)) {
    return (
      <AccessDenied
        title={`You do not have access to ${mod?.title || 'this module'}`}
        description="Your account has not been given this module. Ask your administrator to add it to your permissions."
        action={
          <Button as={Link} to="/portal" className="mt-2">
            Back to home
          </Button>
        }
      />
    )
  }

  return (
    <AccessDenied
      title={`${mod?.title || 'This module'} is not enabled`}
      description="Your organization does not currently have access to this module. Ask your administrator to request it — nothing here is missing or broken."
      action={
        <Button as={Link} to="/portal" className="mt-2">
          Back to home
        </Button>
      }
    />
  )
}
