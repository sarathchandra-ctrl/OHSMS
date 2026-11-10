// The database: one SQLite file (Cloudflare D1, or Node's SQLite in Docker).
//
// Every record the app stores is a row of `documents`, addressed by
// (collection path, id) with its fields as JSON — the shape the app's data
// layer was written against (src/shared/data/index.js). Who may read or write
// which row is decided in stack/policy.mjs, before any SQL runs; SQLite has
// no row-level security of its own.
//
// auth_secrets (password hashes), auth_totp (sealed two-step login secrets)
// and auth_pending (lockout counters, reset links, sign-in tickets) are
// reached only by stack/passwords.mjs, never through /data.
// commit_guard exists to fail a batch on purpose (stack/engine.mjs).

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS documents (
     path TEXT NOT NULL,
     id TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 1,
     data TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (path, id)
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS users_by_email ON documents (lower(json_extract(data, '$.email')))
     WHERE path = 'users'`,
  `CREATE TABLE IF NOT EXISTS auth_secrets (
     uid TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS auth_pending (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS auth_totp (
     uid TEXT PRIMARY KEY,
     secret TEXT NOT NULL,
     last_step INTEGER NOT NULL DEFAULT -1,
     enabled_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS commit_guard (ok INTEGER NOT NULL)`,
]

let applied = new WeakSet()

/** Creates the tables if missing. Cheap to call; done once per database handle. */
export async function ensureSchema(db) {
  if (applied.has(db)) return
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
  applied.add(db)
}

export function _resetSchemaCache() {
  applied = new WeakSet()
}
