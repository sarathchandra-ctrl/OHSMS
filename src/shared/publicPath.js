// A file from public/ (the logo, store badges, the legal pages), under the
// path the app is served from. That is '/' for a normal deployment and
// '/<repo>/' for the GitHub Pages demo, where a bare '/brand/logo.svg' would
// point at the wrong site.
export function publicPath(path) {
  const base = String(import.meta.env?.BASE_URL || '/')
  return `${base.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`
}
