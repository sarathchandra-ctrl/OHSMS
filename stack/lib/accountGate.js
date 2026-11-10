// An account that is signed in but not yet allowed to use the app.
//
// Two reasons, and every check that asks "may this person act?" must ask
// both (stack/policy.mjs, presign, data keys, file deletes, the server jobs):
//   • a temporary password an administrator issued is still in force;
//   • two-step login is required for them and not yet set up.
// Until both are cleared they reach their own profile and the steps that
// clear them, and nothing else.
export const accountGated = (profile) =>
  profile?.mustChangePassword === true ||
  (profile?.mfaRequired === true && profile?.mfaEnabled !== true)
