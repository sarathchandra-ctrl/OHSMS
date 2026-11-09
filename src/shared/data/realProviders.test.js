// The OIDC discovery and issuer rules (stack/oidc.mjs) against the real
// providers' published configuration, not stand-ins. Needs the internet, so
// it runs only when asked:
//
//   WEEHS_LIVE_IDP=1 npx vitest run src/shared/data/realProviders.test.js
//
// What this proves: the endpoints WEEHS would send a company's people to are
// the ones Google and Microsoft publish, and the exact-issuer rule accepts a
// real single tenant and refuses Microsoft's multi-tenant "common" endpoint.
// What it cannot: a person signing in, which needs a real account in a real
// tenant (docs/SELF-HOSTING.md, "Known limits").
import { describe, expect, it } from 'vitest'
import { authorizeUrl, endpointsFor } from '../../../stack/oidc.mjs'

const live = process.env.WEEHS_LIVE_IDP === '1'

describe.skipIf(!live)('real identity providers', () => {
  it('Google: discovery, exact issuer, https endpoints', async () => {
    const google = await endpointsFor('https://accounts.google.com')
    expect(google).toEqual({
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    })
    // Google's issuer has no trailing slash; one typed with it is another issuer.
    await expect(endpointsFor('https://accounts.google.com/')).rejects.toThrow(/another issuer/)
  })

  it('Google: the sign-in request WEEHS builds is one Google reads', async () => {
    const google = await endpointsFor('https://accounts.google.com')
    const url = authorizeUrl({
      authorizationEndpoint: google.authorizationEndpoint,
      clientId: 'weehs-not-a-registered-client.apps.googleusercontent.com',
      redirectUri: 'https://ehs.example.com/auth/callback',
      state: 'state-value',
      challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    })
    const res = await fetch(url, { redirect: 'manual' })
    // Google parsed the request (PKCE, redirect URI, scope) and refused only
    // the made-up client: its error page carries invalid_client, encoded.
    expect(res.status).toBe(302)
    const err = new URL(res.headers.get('location')).searchParams.get('authError') || ''
    expect(Buffer.from(err, 'base64').toString('latin1')).toContain('invalid_client')
  })

  it('Microsoft Entra: a single tenant is accepted, "common" is refused', async () => {
    // Microsoft's own published tenant; any organization's tenant ID works the same.
    const tenant = '72f988bf-86f1-41af-91ab-2d7cd011db47'
    const entra = await endpointsFor(`https://login.microsoftonline.com/${tenant}/v2.0`)
    expect(entra.tokenEndpoint).toBe(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
    )
    expect(entra.userinfoEndpoint).toBe('https://graph.microsoft.com/oidc/userinfo')
    // Multi-tenant: its document names "{tenantid}", not itself, and a
    // multi-tenant registration admits other organizations' accounts.
    await expect(endpointsFor('https://login.microsoftonline.com/common/v2.0')).rejects.toThrow(
      /another issuer/
    )
  })
})
