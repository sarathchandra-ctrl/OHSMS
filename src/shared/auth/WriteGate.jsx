import { Eye } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useReadOnly } from './AuthContext'

/**
 * A page that only creates or edits (a "new" route). For a view-only role it
 * says so instead of opening a form whose save the server will refuse.
 */
export default function WriteGate({ children, back = '/portal' }) {
  const readOnly = useReadOnly()
  if (!readOnly) return children
  return (
    <div className="card mx-auto mt-8 max-w-lg space-y-3 p-6 text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-surface-100 text-ink-600">
        <Eye size={20} aria-hidden="true" />
      </span>
      <h1 className="text-lg font-bold text-ink-900">View-only access</h1>
      <p className="text-sm text-ink-600">
        Your role can look at records but not create or change them. Ask an administrator if
        you need to.
      </p>
      <Link to={back} className="btn-soft inline-flex">
        Back
      </Link>
    </div>
  )
}
