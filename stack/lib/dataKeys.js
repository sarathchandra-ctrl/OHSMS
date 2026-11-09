// ─────────────────────────────────────────────────────────────────────────────
// The key service: where an organization's encryption keys come from, how they
// are stored, and who is given which half.
//
// This is the escrow in "escrowed envelope encryption". The keys are generated
// here, wrapped under a master key held in Secret Manager, and stored wrapped in
// Firestore where no client rule grants access to them. The consequence is
// stated plainly because it is the whole design decision: THIS PROJECT CAN
// DECRYPT ITS TENANTS' DATA. Anyone holding the master secret and the Firestore
// documents can recover every key, and therefore every sealed field.
//
// That is deliberate, and it is what the alternative costs. A zero-knowledge
// scheme — a passphrase that never leaves the browser — would put the data
// beyond this project as well, and it would also put it beyond:
//
//   · statutory retention. Occupational injury records carry a legal minimum
//     retention that outlives any one administrator's memory of a passphrase.
//     A forgotten passphrase would not be an inconvenience, it would be the
//     destruction of records the organization is required to hold.
//   · the migrations already in this codebase. seedInjuryRecords compares
//     clinical field values to prove a record landed before deleting the
//     original; landedIntact does the same for record pointers. Both run with
//     the Admin SDK and would be reading ciphertext they could not compare.
//   · SSO members, who have no password to derive anything from.
//
// So the threat this closes is everything BELOW the application: an exported
// backup, a bucket left open, a support engineer with project Viewer, a
// Firestore rule that turns out to be one `match` too wide. It does not close
// the threat of this project's own operators, and no amount of client-side
// crypto with a recoverable key ever could.
//
// ── Two keys, and the reason the medical one is a keypair ────────────────────
//
// See src/shared/crypto/policy.js for the full reasoning. In short: /injuries,
// /injuries/records and /illnesses are `allow read: if isManagerOf(orgId)` while
// their WRITES come through the generic isWriterOf rule, so an ordinary member
// files a colleague's medication and cannot read it back. A symmetric key given
// to writers would hand every member every colleague's clinical record, so the
// medical class is an RSA keypair: the public half goes to anyone who may write,
// the private half only to admin and manager.
//
// Pure logic only — nothing here touches Firestore, Auth or the network.
// index.js does that with what these functions decide, the same split
// qrMirrors.js and incidentMedical.js already use, and the reason the release
// rules below can be tested without a database.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MUST stay identical to GENERAL/MEDICAL in src/shared/crypto/policy.js and to
 * the key ids embedded in every sealed value already written. functions/ deploys
 * as its own package and cannot import from src/, so this is a copy — the same
 * seam, and the same duty to stay in step, as REGION and MEDICAL_FIELDS.
 */
export const GENERAL = 'general'
export const MEDICAL = 'medical'

/**
 * Where the keyset lives: organizations/{orgId}/meta/cryptoKeys.
 *
 * Under /meta because that subcollection is already carved out of the generic
 * grants in firestore.rules for the stats and counter documents, so adding a
 * document here does not need a new top-level name added to two exclusion lists
 * — and one added to one list is the hole shipped. The rule for this exact
 * document id denies every client operation outright; see firestore.rules.
 */
export const KEY_DOC_PATH = (orgId) => `organizations/${orgId}/meta/cryptoKeys`

/** Bumped only when the SHAPE of the stored document changes. */
export const KEYSET_VERSION = 1

/** 256-bit AES for the general class, 256-bit master, 2048-bit RSA for medical. */
export const KEY_BYTES = 32
export const IV_BYTES = 12
export const WRAP_ALG = { name: 'RSA-OAEP', hash: 'SHA-256' }
export const WRAP_MODULUS_BITS = 2048

const subtle = () => globalThis.crypto.subtle
const utf8 = new TextEncoder()

// ── base64URL ────────────────────────────────────────────────────────────────
// Byte-identical to src/shared/crypto/envelope.js. A key exported here is
// imported there, so a disagreement about padding or alphabet is an
// organization that cannot read anything it has written.

export function toB64u(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(text) {
  return new Uint8Array(Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

/**
 * The key id that goes into every sealed value.
 *
 * `<class>.<version>` — the dot matters, because the envelope format is
 * colon-separated and a key id carrying a colon would produce values that parse
 * back with the wrong segments and are silently unreadable.
 */
export const keyIdFor = (keyClass, version = 1) => `${keyClass}.${version}`

/** The class and version a stored id names, or null if it is not one of ours. */
export function parseKeyId(keyId) {
  const m = /^(general|medical)\.(\d{1,4})$/.exec(String(keyId || ''))
  return m ? { keyClass: m[1], version: Number(m[2]) } : null
}

// ── Wrapping ─────────────────────────────────────────────────────────────────

/**
 * The binding on a wrapped key.
 *
 * A wrapped key is a blob in a Firestore document, and the Admin SDK that
 * unwraps it consults no rule. Without this, a blob copied from one
 * organization's key document into another's would unwrap cleanly under the same
 * master key, and the second tenant would be handed the first tenant's key —
 * which is a cross-tenant break performed by the escrow itself.
 */
const wrapAad = (orgId, keyId) => utf8.encode(`ohsms:dek:${orgId}:${keyId}`)

async function masterKey(masterSecret) {
  const bytes = fromB64u(masterSecret)
  if (bytes.length !== KEY_BYTES) {
    // Refuse rather than derive. A short or mistyped secret that got stretched
    // into a valid-looking key would encrypt every tenant's keys under
    // something nobody can reproduce deliberately.
    throw new Error(`DATA_KEY_MASTER must be ${KEY_BYTES} base64url-encoded bytes, got ${bytes.length}.`)
  }
  return subtle().importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** `iv || ciphertext`, base64URL. One string, so the stored shape stays flat. */
export async function wrapKey(masterSecret, orgId, keyId, plaintextBytes) {
  const key = await masterKey(masterSecret)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: wrapAad(orgId, keyId) },
    key,
    plaintextBytes,
  ))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return toB64u(out)
}

/** The plaintext key bytes back. Throws if the blob was moved or altered. */
export async function unwrapKey(masterSecret, orgId, keyId, wrapped) {
  const key = await masterKey(masterSecret)
  const all = fromB64u(wrapped)
  if (all.length <= IV_BYTES) throw new Error('Wrapped key is truncated.')
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: all.subarray(0, IV_BYTES), additionalData: wrapAad(orgId, keyId) },
    key,
    all.subarray(IV_BYTES),
  )
  return new Uint8Array(plain)
}

// ── Generation ───────────────────────────────────────────────────────────────

/**
 * A complete keyset for one organization, ready to store.
 *
 * The private halves are wrapped before this returns, so nothing above ever
 * holds an unwrapped key longer than it takes to wrap it. `medicalPublic` is
 * stored in the CLEAR on purpose: a public key is not a secret, and keeping it
 * unwrapped is what lets an ordinary member be handed it without the callable
 * having to unwrap anything on their behalf.
 */
export async function generateKeyset(masterSecret, orgId, version = 1) {
  const generalId = keyIdFor(GENERAL, version)
  const medicalId = keyIdFor(MEDICAL, version)

  const generalKey = globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  const pair = await subtle().generateKey(
    { ...WRAP_ALG, modulusLength: WRAP_MODULUS_BITS, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt'],
  )
  const spki = new Uint8Array(await subtle().exportKey('spki', pair.publicKey))
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey))

  return {
    version: KEYSET_VERSION,
    general: {
      keyId: generalId,
      wrappedKey: await wrapKey(masterSecret, orgId, generalId, generalKey),
    },
    medical: {
      keyId: medicalId,
      publicKey: toB64u(spki),
      wrappedPrivateKey: await wrapKey(masterSecret, orgId, medicalId, pkcs8),
    },
  }
}

// ── Release ──────────────────────────────────────────────────────────────────

/**
 * What each half requires of the caller.
 *
 * Every line is a copy of a rule in firestore.rules, and that is the point: a
 * key released on a looser test than the documents it opens makes the rule
 * decorative, and one released on a stricter test locks people out of their own
 * work with an error no screen can explain.
 *
 *   general        isApprovedMemberOf — the auditor included, because reading
 *                  the safety record is what an auditor is given a login for.
 *   medicalPublic  isApprovedMemberOf. A public key opens nothing; withholding
 *                  it would only stop a member filing an injury report, and the
 *                  refusal would arrive as a failed save.
 *   medicalPrivate isManagerOf — `role in ['admin','manager']`. NOT
 *                  isElevatedOf, which includes 'auditor': an outside reviewer
 *                  confirming injuries are recorded does not need to read what
 *                  medication a named colleague is on. This single line is what
 *                  the medical class is for.
 */
export function grantsFor(profile) {
  // mustChangePassword mirrors passwordIsOwn() in firestore.rules, which
  // isApprovedMemberOf already folds in: someone still holding an
  // administrator-issued temporary password can read nothing in the app, so
  // handing them the keys that open it would be the one grant looser than the
  // rules — and it would survive a password reset the rules would have caught.
  const approved = Boolean(profile)
    && profile.status === 'approved'
    && profile.mustChangePassword !== true
  const role = String(profile?.role || '')
  return {
    general: approved,
    medicalPublic: approved,
    medicalPrivate: approved && (role === 'admin' || role === 'manager'),
  }
}

/**
 * The payload for one caller: their keys, unwrapped, and nothing else.
 *
 * Returns `{ general?, medical? }` shaped for src/shared/crypto/keyring.js.
 * A half the caller is not entitled to is ABSENT rather than null — the keyring
 * treats a missing key as "redact these fields", which is the auditor opening an
 * injury record and seeing the clinical columns omitted rather than an error.
 */
export async function releaseKeyset(masterSecret, orgId, keyset, profile) {
  const grants = grantsFor(profile)
  const out = {}

  if (grants.general && keyset?.general?.wrappedKey) {
    out.general = {
      keyId: keyset.general.keyId,
      key: toB64u(await unwrapKey(masterSecret, orgId, keyset.general.keyId, keyset.general.wrappedKey)),
    }
  }

  if (grants.medicalPublic && keyset?.medical?.publicKey) {
    out.medical = { keyId: keyset.medical.keyId, publicKey: keyset.medical.publicKey }
    if (grants.medicalPrivate && keyset.medical.wrappedPrivateKey) {
      out.medical.privateKey = toB64u(
        await unwrapKey(masterSecret, orgId, keyset.medical.keyId, keyset.medical.wrappedPrivateKey),
      )
    }
  }

  return out
}
