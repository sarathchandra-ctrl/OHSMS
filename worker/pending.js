// Sign-ins in progress, kept in Postgres.
//
// On one long-lived server these live in memory (a Map). On Cloudflare the
// redirect to the identity provider and the answer that comes back can be
// served by different isolates, so both the server's own pending entries
// (OIDC state + PKCE verifier, the SAML browser binding) and node-saml's cache
// of the AuthnRequest ids it issued are rows in auth_pending instead.
// Entries expire after ten minutes; a read never returns an expired one.

const TTL_SECONDS = 10 * 60

function parse(value) {
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** The Map-shaped store stack/handler.mjs takes as `codes` (all async). */
export function pendingStore(db, { ttlSeconds = TTL_SECONDS } = {}) {
  return {
    async get(key) {
      const res = await db.query(
        'SELECT value FROM auth_pending WHERE key = $1 AND expires_at > now()',
        [String(key)]
      )
      return res.rows[0] ? parse(res.rows[0].value) : undefined
    },
    async set(key, value) {
      await db.query(
        `INSERT INTO auth_pending (key, value, expires_at)
         VALUES ($1, $2::jsonb, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [String(key), JSON.stringify(value), ttlSeconds]
      )
      // Keep the table small; expired rows are never read anyway.
      await db.query('DELETE FROM auth_pending WHERE expires_at < now()')
      return this
    },
    async delete(key) {
      const res = await db.query('DELETE FROM auth_pending WHERE key = $1', [String(key)])
      return res.affectedRows > 0
    },
  }
}

/** node-saml's CacheProvider interface over the same table. */
export function samlCacheProvider(db) {
  const store = pendingStore(db)
  const k = (key) => `samlreq:${key}`
  return {
    async saveAsync(key, value) {
      const existing = await store.get(k(key))
      if (existing !== undefined) return null
      const item = { value, createdAt: Date.now() }
      await store.set(k(key), item)
      return item
    },
    async getAsync(key) {
      const item = await store.get(k(key))
      return item ? item.value : null
    },
    async removeAsync(key) {
      if (key == null) return null
      const item = await store.get(k(key))
      if (!item) return null
      await store.delete(k(key))
      return key
    },
  }
}
