// Company SAML. The assertion is checked by the IdP certificate on the host.
// An unsigned response is not an identity. The certificate is a secret-store
// value, not a field on the provisioning request.

import { SAML } from '@node-saml/node-saml'
import { inflateRawSync } from 'node:zlib'

/**
 * The certificate as node-saml accepts it whatever shape it arrived in.
 *
 * The handoff page collects it in a single-line field, and an <input> drops
 * line breaks, so a pasted PEM arrives as one line. node-saml rejects that
 * form, and the failure surfaced as nothing more than every sign-in being
 * refused. The base64 body alone is accepted, so that is what is kept.
 */
export function normalizeIdpCert(cert) {
  return String(cert || '')
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
}

export function samlClient({ issuer, callbackUrl, idpCert, entryPoint, cacheProvider }) {
  const cert = normalizeIdpCert(idpCert)
  if (!cert || !entryPoint) {
    throw new Error('saml: the IdP certificate and entry point are required')
  }
  return new SAML({
    issuer,
    callbackUrl,
    idpCert: cert,
    entryPoint,
    wantAssertionsSigned: true,
    identifierFormat: null,
    // A response is accepted only as the answer to an AuthnRequest this host
    // issued, once. The library default is 'never', under which a signed
    // response captured from one sign-in can be posted again, or posted
    // without anyone having started a sign-in, until its timestamps expire.
    // The request ids live in this client's cache, so the host must keep one
    // cache for both legs: one client in a long-lived server, or a shared
    // store on Cloudflare (stack/handler.mjs, worker/pending.js).
    validateInResponseTo: 'always',
    // Where those ids are kept. Undefined is node-saml's in-memory cache.
    ...(cacheProvider ? { cacheProvider } : {}),
  })
}

/** The ID of the AuthnRequest carried in a redirect-binding authorize URL. */
export function authnRequestId(authorizeUrl) {
  try {
    const raw = new URL(authorizeUrl).searchParams.get('SAMLRequest') || ''
    const xml = inflateRawSync(Buffer.from(raw, 'base64')).toString('utf8')
    return xml.match(/\sID="([^"]+)"/)?.[1] || ''
  } catch {
    return ''
  }
}

export async function identityFromSaml(client, samlResponse) {
  let profile
  try {
    const checked = await client.validatePostResponseAsync({ SAMLResponse: samlResponse })
    profile = checked.profile
  } catch {
    return { ok: false, reason: 'assertion' }
  }
  const sub = profile?.nameID
  if (!sub) return { ok: false, reason: 'assertion' }
  const email = first(profile, EMAIL_CLAIMS) || (String(sub).includes('@') ? sub : '')
  const given = first(profile, [CLAIM.givenName])
  const family = first(profile, [CLAIM.surname])
  return {
    ok: true,
    inResponseTo: String(profile.inResponseTo || ''),
    sub: String(sub),
    email: String(email || ''),
    name: String(
      first(profile, NAME_CLAIMS) || [given, family].filter(Boolean).join(' ') || email || sub
    ),
    groups: all(profile, GROUP_CLAIMS),
  }
}

// Attribute names differ by identity provider. Okta and Google send short
// names when an admin maps them (email, mail, displayName); Microsoft Entra
// and AD FS send the WS-Federation claim URIs, and put the user principal
// name, not the email, in NameID. Invites are matched by email, so reading
// only the short names meant that an Entra user whose UPN differs from their
// address never matched their invite.
const CLAIM = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  displayName: 'http://schemas.microsoft.com/identity/claims/displayname',
  givenName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  surname: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
}
// Group names (Okta, Google, Keycloak: whatever the admin named the
// attribute, usually "groups"), or group object IDs (Entra's claim URI).
const GROUP_CLAIMS = [
  'groups',
  'memberOf',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  'http://schemas.xmlsoap.org/claims/Group',
]
const EMAIL_CLAIMS = ['email', 'mail', 'emailAddress', CLAIM.email]
const NAME_CLAIMS = ['displayName', CLAIM.displayName]

function first(profile, names) {
  for (const n of names) {
    const v = profile?.[n] ?? profile?.attributes?.[n]
    const one = Array.isArray(v) ? v[0] : v
    if (typeof one === 'string' && one.trim()) return one.trim()
  }
  return ''
}

/** Every value of every named attribute, as distinct strings (at most 200). */
function all(profile, names) {
  const out = new Set()
  for (const n of names) {
    const v = profile?.[n] ?? profile?.attributes?.[n]
    for (const one of Array.isArray(v) ? v : v == null ? [] : [v]) {
      if (typeof one === 'string' && one.trim() && one.length <= 256) out.add(one.trim())
    }
  }
  return [...out].slice(0, 200)
}
