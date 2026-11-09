// The organization's server as a Node HTTP server (Docker, tests). The
// request handling itself is stack/handler.mjs, which the Cloudflare Worker
// (worker/index.js) calls directly without node:http.

import { createServer } from 'node:http'
import { createOwnStackHandler } from './handler.mjs'

export { MAX_BODY_BYTES, createOwnStackHandler } from './handler.mjs'

export function createOwnStackServer(options) {
  return createServer(createOwnStackHandler(options))
}
