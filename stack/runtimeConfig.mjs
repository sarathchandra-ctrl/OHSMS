// What the app is told about its server, and which paths are the server's.
// No Node-only imports: the Cloudflare Worker uses this too.

// worker/index.js forwards the same list; keep the two in step.
export const API_PREFIXES = [
  '/data',
  '/auth/',
  '/presign',
  '/blob',
  '/rpc/',
  '/health',
]


/**
 * The settings the app reads before it starts (src/shared/runtimeConfig.js),
 * from what this server is: the gateway is this origin, and sign-in is email
 * and password, kept by this server.
 *
 * Every value is a JSON string, and `<` is escaped, so nothing a request
 * carried can close the script or start another one.
 */
export function runtimeConfigScript({ origin }) {
  const config = {
    DATA_DRIVER: 'postgres',
    DATA_GATEWAY: origin,
    STORAGE_DRIVER: 's3',
    S3_PRESIGN_ENDPOINT: `${origin}/presign`,
    AUTH_METHOD: 'password',
    AUTH_TOTP: 'off',
  }
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  return `window.__OHSMS_CONFIG__ = ${json};\n`
}

