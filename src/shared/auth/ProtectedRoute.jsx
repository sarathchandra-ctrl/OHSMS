import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { can } from './permissions'
import SamLoading from '../layout/SamLoading'

/**
 * Guards the authenticated app. Redirects:
 *   - not signed in            → /login
 *   - signed in, no profile    → /login (edge case: half-created account)
 *   - signed in, pending       → /pending
 *   - requireAdmin & not admin → /dashboard
 *   - requireCap & lacking it  → /dashboard
 */
export default function ProtectedRoute({ children, requireAdmin = false, requireCap = null }) {
  const { loading, isAuthed, profile, isApproved, isAdmin, role } = useAuth()
  const location = useLocation()

  if (loading) return <SamLoading label="Getting your workspace ready…" />
  if (!isAuthed) return <Navigate to="/login" state={{ from: location }} replace />
  // Authenticated but the profile is still resolving — wait, don't bounce to
  // /login (bouncing races the login redirect and causes a loop).
  if (!profile) return <SamLoading label="Loading your profile…" />
  if (!isApproved) return <Navigate to="/pending" replace />
  // Turned away from an admin-only screen — send them to their own home rather
  // than to /hub, which is no longer where anyone lands and which a plain
  // member has no particular reason to be looking at.
  if (requireAdmin && !isAdmin) return <Navigate to="/portal" replace />
  if (requireCap && !can(role, requireCap)) return <Navigate to="/portal" replace />

  return children
}
