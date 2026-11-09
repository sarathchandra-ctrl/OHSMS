// What the server must remember across a restart, beyond the documents
// themselves: the sign-in configuration connected at /setup.
//
// It is kept in one table on the same Postgres. Secrets are sealed before
// they reach the table: AES-256-GCM under STATE_KEY, with the row's kind and
// id as associated data so a sealed value cannot be moved onto another row. A
// database dump without the key does not contain the IdP certificate or the
// client secret.
//
// The table is owned by the login role and granted to neither ohsms_browser
// nor ohsms_worker, so the data API — which always runs as one of those —
// cannot read it.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const STATE_SQL = `
CREATE TABLE IF NOT EXISTS control_state (
  kind text NOT NULL,
  id text NOT NULL,
  data jsonb,
  sealed text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
REVOKE ALL ON control_state FROM PUBLIC;
`

/** STATE_KEY: 32 random bytes, base64. Anything else refuses to start. */
export function parseStateKey(value) {
  const key = Buffer.from(String(value || '').trim(), 'base64')
  if (key.length !== 32) {
    throw new Error('STATE_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)')
  }
  return key
}

export function seal(key, aad, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

export function unseal(key, aad, sealed) {
  const raw = Buffer.from(sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(raw.subarray(12, 28))
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  return JSON.parse(text)
}

/**
 * Open (and create) the state table on `db` and load the sign-in config.
 * @returns {{ auth: object|null, saveAuth(auth): Promise<void> }}
 */
export async function openState(db, { key }) {
  await db.exec(STATE_SQL)
  const aad = 'auth:current'
  const rows = (
    await db.query("SELECT sealed FROM control_state WHERE kind = 'auth' AND id = 'current'")
  ).rows
  // A wrong STATE_KEY throws here, at start-up, rather than serving a host
  // that has silently forgotten its sign-in.
  const auth = rows[0]?.sealed ? unseal(key, aad, rows[0].sealed) : null
  return {
    auth,
    saveAuth: async (value) => {
      await db.query(
        `INSERT INTO control_state (kind, id, data, sealed, updated_at)
         VALUES ('auth', 'current', NULL, $1, now())
         ON CONFLICT (kind, id) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
        [seal(key, aad, value)]
      )
    },
  }
}
