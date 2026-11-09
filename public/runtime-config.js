// Deployment settings the app reads before it starts (src/shared/runtimeConfig.js).
//
// This static copy sets nothing. The organization's server answers
// /runtime-config.js itself (stack/app.mjs) with its gateway and the sign-in
// connected at /setup, and the Cloudflare Worker forwards this path to it
// (worker/index.js), so this file is only seen by a build served without one.
