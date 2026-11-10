import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(path, 'utf8')

describe('public legal pages', () => {
  const privacy = read('public/privacy.html')
  const terms = read('public/terms.html')
  const wrangler = read('wrangler.jsonc')
  const login = read('src/pages/auth/Login.jsx')

  it('serves /privacy and /terms as static files ahead of the app shell', () => {
    // Cloudflare's default html_handling resolves /privacy to privacy.html
    // before the single-page fallback; the files only have to exist.
    expect(wrangler).toMatch(/single-page-application/)
    expect(privacy).toMatch(/<html/i)
    expect(terms).toMatch(/<html/i)
  })

  it('puts the privacy policy in the file a crawler receives, with no script', () => {
    expect(privacy).not.toMatch(/<script/i)
    expect(privacy).toContain('Privacy Policy')
    expect(privacy).toContain('WEEHS (weehs.org)')
    expect(privacy).toContain('Effective 25 October 2026')
    expect(privacy).toContain('info@weehs.org')
    expect(privacy).toContain('href="mailto:info@weehs.org"')
    expect(privacy).toContain('href="tel:+917793966625"')
    expect(privacy).toContain('+91 77939 66625')
    expect(privacy).toContain('Account information')
    expect(privacy).toContain('Phone numbers authorised for a bot')
    expect(privacy).toContain('Messages sent to a bot')
    expect(privacy).toContain('Site and safety records')
    expect(privacy).toContain('Location, if you share it')
    expect(privacy).toContain('Google Firebase and Google Cloud')
    expect(privacy).toContain('does not sell personal information')
    expect(privacy).toContain('How long we keep it')
    expect(privacy).toContain('How we protect it')
    expect(privacy).toContain('deletion')
    expect(privacy).not.toMatch(/Telegram|telegram/)
  })

  it('puts the terms in the same kind of document', () => {
    expect(terms).not.toMatch(/<script/i)
    expect(terms).toContain('Terms of Use')
    expect(terms).toContain('WEEHS (weehs.org)')
    expect(terms).toContain('Effective 25 October 2026')
    expect(terms).toContain('info@weehs.org')
    expect(terms).toContain('href="mailto:info@weehs.org"')
    expect(terms).toContain('href="tel:+917793966625"')
    expect(terms).toContain('+91 77939 66625')
    expect(terms).toContain('Acceptable use')
    expect(terms).toContain('Accounts')
    expect(terms).toContain('Site-lookup bots')
    expect(terms).toContain('not a guarantee')
    expect(terms).toContain('Intellectual property')
    expect(terms).toContain('Liability')
    expect(terms).toContain('Ending access')
    expect(terms).toContain('laws of India')
    expect(terms).toContain('href="/privacy"')
    expect(terms).not.toMatch(/Telegram|telegram/)
  })

  it('links both documents from the sign-in footer', () => {
    // publicPath keeps the clean URL and adds the app's base path, if any.
    expect(login).toContain("href={publicPath('/privacy')}")
    expect(login).toContain('Privacy Policy')
    expect(login).toContain("href={publicPath('/terms')}")
    expect(login).toContain('Terms of Use')
  })
})
