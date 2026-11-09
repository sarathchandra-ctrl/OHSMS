import { ownStackGateway } from './auth/ownStackSession'

/**
 * Whether this build has a server to talk to, or can only show SetupNeeded.
 * The server is the gateway the deployment names (runtime-config.js, or
 * VITE_DATA_GATEWAY at build time).
 */
export function isAppConfigured({ gateway = ownStackGateway() } = {}) {
  return Boolean(gateway)
}
