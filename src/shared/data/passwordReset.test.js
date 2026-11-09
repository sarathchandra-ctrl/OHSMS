// Password reset by email, through the real server (stack/app.mjs) on PGlite.
// The mail sender is a stub that records what would have been sent.
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { createDedicatedApp } from '../../../stack/app.mjs'
import { resendMailer } from '../../../worker/mail.js'

const ADMIN = { email: 'ana@cult.test', password: 'first-admin-pass-1' }

async function start({ mail = true } = {}) {
  const sent = []
  const app = await createDedicatedApp({
    db: new PGlite(),
    origin: 'https://ehs.example.com',
    sessionSecret: 's'.repeat(40),
    dataKeyMaster: Buffer.alloc(32, 7).toString('base64'),
    mail: mail
      ? async (m) => {
          sent.push(m)
          return { sent: true }
        }
      : null,
    bootstrap: { orgName: 'Cult Fit', adminEmail: ADMIN.email, adminPassword: ADMIN.password },
  })
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const post = (path, body) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
  // The mail goes out after the response; give it a moment.
  const settle = () => new Promise((r) => setTimeout(r, 300))
  const tokenFrom = (m) => m.text.match(/#token=([\w-]+)/)[1]
  const stop = () => new Promise((resolve) => app.server.close(resolve))
  return { origin, post, sent, settle, tokenFrom, stop }
}

describe('reset by email', () => {
  it('emails a one-time link that sets a new password', async () => {
    const s = await start()
    const asked = await s.post('/auth/forgot', { email: 'Ana@Cult.test' })
    expect(asked.status).toBe(200)
    await s.settle()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0].to).toBe('ana@cult.test')
    expect(s.sent[0].text).toContain('https://ehs.example.com/reset-password#token=')

    const token = s.tokenFrom(s.sent[0])
    expect((await s.post('/auth/reset', { token, password: 'short' })).body.reason).toBe('policy')
    expect((await s.post('/auth/reset', { token, password: 'brand-new-pass-1' })).status).toBe(200)
    // Used once; never again.
    expect((await s.post('/auth/reset', { token, password: 'other-new-pass-2' })).body.reason).toBe('link')

    expect((await s.post('/auth/password', ADMIN)).status).toBe(401)
    const signedIn = await s.post('/auth/password', { email: ADMIN.email, password: 'brand-new-pass-1' })
    expect(signedIn.body.token).toBeTruthy()
    await s.stop()
  })

  it('answers the same for an address with no account, and sends nothing', async () => {
    const s = await start()
    const known = await s.post('/auth/forgot', { email: ADMIN.email })
    const unknown = await s.post('/auth/forgot', { email: 'ghost@cult.test' })
    expect(unknown.status).toBe(known.status)
    expect(unknown.body).toEqual(known.body)
    await s.settle()
    expect(s.sent.map((m) => m.to)).toEqual([ADMIN.email])
    await s.stop()
  })

  it('refuses a made-up or altered token', async () => {
    const s = await start()
    await s.post('/auth/forgot', { email: ADMIN.email })
    await s.settle()
    const token = s.tokenFrom(s.sent[0])
    const altered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa')
    expect((await s.post('/auth/reset', { token: altered, password: 'brand-new-pass-1' })).body.reason).toBe('link')
    expect((await s.post('/auth/reset', { token: 'x'.repeat(43), password: 'brand-new-pass-1' })).body.reason).toBe('link')
    await s.stop()
  })

  it('sends at most three links an hour to one address', async () => {
    const s = await start()
    for (let i = 0; i < 5; i++) await s.post('/auth/forgot', { email: ADMIN.email })
    await s.settle()
    expect(s.sent).toHaveLength(3)
    await s.stop()
  })

  it('is switched off without a mail sender, and says to ask an administrator', async () => {
    const s = await start({ mail: false })
    const asked = await s.post('/auth/forgot', { email: ADMIN.email })
    expect(asked.status).toBe(503)
    expect(asked.body.message).toMatch(/administrator/)
    const config = await (await fetch(`${s.origin}/runtime-config.js`)).text()
    expect(config).toContain('"RESET_BY_EMAIL":"off"')
    await s.stop()
  })
})

describe('the Resend sender', () => {
  it('posts the message with the key and reports failure without throwing', async () => {
    const calls = []
    const ok = resendMailer({
      apiKey: 're_test',
      from: 'Cult Fit SMS <noreply@example.com>',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return new Response('{}', { status: 200 })
      },
    })
    expect(await ok({ to: 'a@b.test', subject: 'S', text: 'T' })).toEqual({ sent: true })
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect(calls[0].init.headers.Authorization).toBe('Bearer re_test')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      from: 'Cult Fit SMS <noreply@example.com>',
      to: ['a@b.test'],
      subject: 'S',
      text: 'T',
    })
    const failing = resendMailer({
      apiKey: 're_test',
      from: 'x@example.com',
      fetchImpl: async () => new Response('nope', { status: 403 }),
    })
    expect(await failing({ to: 'a@b.test', subject: 'S', text: 'T' })).toEqual({ sent: false })
    expect(resendMailer({ apiKey: '', from: 'x@example.com' })).toBeNull()
  })
})
