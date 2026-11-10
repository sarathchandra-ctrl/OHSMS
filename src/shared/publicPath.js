// A file from public/ (the logo, store badges, the legal pages), under the
// path the app is served from (vite.config.js `base`, '/'). Kept as one
// helper so a deployment under a sub-path needs one change, not one per link.
export function publicPath(path) {
  const base = String(import.meta.env?.BASE_URL || '/')
  return `${base.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`
}
