// What the GitHub deploy (.github/workflows/deploy-cloudflare.yml) reads from
// the repository's Actions secrets and variables, checked before anything is
// deployed, so a value the server would refuse at start (503) or Wrangler
// would trip over never reaches the Worker. Run by scripts/deploy-config.mjs.
//
// Everything here is optional except the API token and account id. A value
// not set in GitHub leaves what wrangler.jsonc and the Worker already have:
//   CLOUDFLARE_WORKER_NAME, CLOUDFLARE_D1_DATABASE_NAME/_ID,
//   CLOUDFLARE_R2_BUCKET_NAME   override the names and ids in wrangler.jsonc
//   SESSION_SECRET, DATA_KEY_MASTER, ADMIN_EMAIL, ADMIN_PASSWORD
//                               Worker secrets, set only where the Worker has
//                               none (see secretsToSet)
//
// No value is ever printed. A problem names the setting, never its content:
// the repository and its Actions logs are public.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const D1_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/i
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * wrangler.jsonc without its comments and trailing commas. String-aware: the
 * file holds "**\/*.sql" and URLs in strings, which a pattern-based stripper
 * would cut in half.
 */
export function parseJsonc(text) {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i += 1
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i += 1
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
    } else {
      out += c
      i += 1
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const given = (env, key) => String(env[key] ?? '').trim()

/** Problems with the settings, by name only. Empty means deployable. */
export function settingsProblems(env = {}) {
  const problems = []
  if (!given(env, 'CLOUDFLARE_API_TOKEN')) problems.push('CLOUDFLARE_API_TOKEN is not set')
  if (!/^[0-9a-f]{32}$/i.test(given(env, 'CLOUDFLARE_ACCOUNT_ID'))) {
    problems.push('CLOUDFLARE_ACCOUNT_ID is not a 32-character Cloudflare account id')
  }
  const check = (key, test, why) => {
    const v = given(env, key)
    if (v && !test(v)) problems.push(`${key} ${why}`)
  }
  check(
    'CLOUDFLARE_WORKER_NAME',
    (v) => WORKER_NAME.test(v),
    'must be lowercase letters, digits and hyphens'
  )
  check(
    'CLOUDFLARE_D1_DATABASE_ID',
    (v) => UUID.test(v),
    'must be the database id (a UUID) from Cloudflare D1'
  )
  check(
    'CLOUDFLARE_D1_DATABASE_NAME',
    (v) => D1_NAME.test(v),
    'must be letters, digits, hyphens or underscores'
  )
  check(
    'CLOUDFLARE_R2_BUCKET_NAME',
    (v) => BUCKET_NAME.test(v),
    'must be 3–63 lowercase letters, digits and hyphens'
  )
  // The rules worker/server.js settingsProblems applies at start.
  check(
    'SESSION_SECRET',
    (v) => v.length >= 32,
    'must be at least 32 characters (openssl rand -hex 32)'
  )
  check(
    'DATA_KEY_MASTER',
    (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32,
    'must be 32 bytes in base64 (openssl rand -base64 32)'
  )
  check('ADMIN_EMAIL', (v) => EMAIL.test(v), 'must be an email address')
  check('ADMIN_PASSWORD', (v) => v.length >= 10, 'must be at least 10 characters')
  if (
    given(env, 'OHSMS_PUBLIC_ORIGIN') &&
    !/^https:\/\/[^/]+\/?$/.test(given(env, 'OHSMS_PUBLIC_ORIGIN'))
  ) {
    problems.push('OHSMS_PUBLIC_ORIGIN must be https://host, with no path')
  }
  return problems
}

/** wrangler.jsonc with the names and ids GitHub overrides. */
export function deployConfig(base, env = {}) {
  const cfg = structuredClone(base)
  const name = given(env, 'CLOUDFLARE_WORKER_NAME')
  if (name) cfg.name = name
  const db = cfg.d1_databases?.[0]
  if (db) {
    if (given(env, 'CLOUDFLARE_D1_DATABASE_ID'))
      db.database_id = given(env, 'CLOUDFLARE_D1_DATABASE_ID')
    if (given(env, 'CLOUDFLARE_D1_DATABASE_NAME'))
      db.database_name = given(env, 'CLOUDFLARE_D1_DATABASE_NAME')
  }
  const bucket = cfg.r2_buckets?.[0]
  if (bucket && given(env, 'CLOUDFLARE_R2_BUCKET_NAME'))
    bucket.bucket_name = given(env, 'CLOUDFLARE_R2_BUCKET_NAME')
  // Paths in the file are relative to it; the generated file sits beside it.
  delete cfg.$schema
  return cfg
}

export const WORKER_SECRETS = ['SESSION_SECRET', 'DATA_KEY_MASTER', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']

/**
 * The secrets to upload: those given in GitHub that the Worker does not
 * already hold. Never a replacement. A new DATA_KEY_MASTER cannot open what
 * the old one sealed, so a changed GitHub secret would make every encrypted
 * field and two-step login unreadable on the next push; a new SESSION_SECRET
 * signs everyone out. Rotating either is a deliberate act with wrangler, not
 * a side effect of a deploy.
 */
export function secretsToSet(env = {}, existing = []) {
  const have = new Set(existing)
  const out = {}
  for (const key of WORKER_SECRETS) {
    if (given(env, key) && !have.has(key)) out[key] = given(env, key)
  }
  return out
}
