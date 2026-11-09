// Settings a deployment supplies when it starts, not when it is built.
//
// The own-stack flags (which data driver, where the gateway is, which sign-in)
// were compiled in by Vite, so every company needed its own build of the app:
// the image you handed one company could not be handed to the next. A
// dedicated host now serves /runtime-config.js, a classic script index.html
// loads before the app, which sets window.__OHSMS_CONFIG__ from what that host
// actually is. Firebase Hosting serves the static public/runtime-config.js,
// which sets nothing, so the shared site reads its build-time values exactly
// as before.
//
// Only the keys below may come from there. A Firebase key or anything else a
// page could use to point the app at another project stays build-time.

export const RUNTIME_KEYS = [
  'DATA_DRIVER',
  'DATA_GATEWAY',
  'STORAGE_DRIVER',
  'S3_PRESIGN_ENDPOINT',
  'AUTH_METHOD',
  'AUTH_TOTP',
  'RESET_BY_EMAIL',
]

function fromPage(name) {
  const config = typeof globalThis !== 'undefined' ? globalThis.__OHSMS_CONFIG__ : undefined
  if (!config || typeof config !== 'object' || !RUNTIME_KEYS.includes(name)) return undefined
  const value = config[name]
  return typeof value === 'string' ? value : undefined
}

function fromBuild(name) {
  const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined
  const value = env ? env[`VITE_${name}`] : undefined
  return typeof value === 'string' ? value : ''
}

/** `name` without the VITE_ prefix. The deployment's value wins over the build's. */
export function runtimeEnv(name) {
  const value = fromPage(name)
  return value !== undefined ? value : fromBuild(name)
}
