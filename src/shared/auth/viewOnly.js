// The auditor's view-only mode, outside React.
//
// The auditor role is read-only on the server (stack/policy.mjs refuses
// every write), but the screens offered it every create, import and status
// control. And toastCaught stays silent on a refused write, on the
// assumption that the screen never offered the control: so an auditor's
// change simply snapped back with no word. The screens now hide the
// controls (`data-write`, WriteGate, ModuleTabs `write`), and a refusal that
// still happens says why (toastCaught).

let viewOnly = false

/** Set by AuthContext when the signed-in role changes. */
export function setViewOnly(on) {
  viewOnly = Boolean(on)
  try {
    document.documentElement.classList.toggle('read-only', viewOnly)
  } catch {
    // No document in the test runner.
  }
}

export const isViewOnly = () => viewOnly

export const VIEW_ONLY_MESSAGE =
  'View-only access: your role can look at records but not change them.'
