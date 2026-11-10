import { createContext, useContext } from 'react'

// One live read of the inbox for the bell and the Notifications page, which
// share the header (AppChrome) and would otherwise poll the same rows twice.
// The provider is InboxProvider.jsx; this file is only the context and its hook
// (kept apart so fast refresh can treat the provider as a component file).
export const InboxContext = createContext(null)

export function useInbox() {
  return useContext(InboxContext) || { uid: '', items: [], ready: false, unread: 0 }
}
