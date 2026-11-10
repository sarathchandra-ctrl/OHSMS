import toast from 'react-hot-toast'
import { isPermissionDenied } from './permissionDenied'
import { writeErrorMessage } from './writeError'
import { isViewOnly, VIEW_ONLY_MESSAGE } from '../auth/viewOnly'

/**
 * Report a caught write/load failure — unless it was an access check.
 *
 * A refused write is expected whenever the UI hid a control the rules also
 * refuse. Toasting that as an error is how "Missing or insufficient
 * permissions" appeared on screens the person was never meant to mutate.
 */
export function toastCaught(err, fallback = 'Could not save', opts = {}) {
  // A view-only role was offered a control after all: say why nothing
  // happened, once, rather than letting the change silently snap back.
  if (isPermissionDenied(err) && isViewOnly()) {
    toast.error(VIEW_ONLY_MESSAGE, { id: 'view-only' })
    return
  }
  if (isPermissionDenied(err)) return
  const online = opts.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true)
  const text =
    typeof err === 'string'
      ? err
      : writeErrorMessage(err, { ...opts, online }) || err?.message || fallback
  if (isPermissionDenied({ message: text })) return
  toast.error(text || fallback)
}
