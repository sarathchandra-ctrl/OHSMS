import { describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { createDedicatedApp } from './app.mjs'
import { MAX_FAILURES_PER_SOURCE } from './passwords.mjs'
import { clientIpFor, isPrivateAddress } from './clientIp.mjs'

const req = (socket, headers = {}) => ({ socket: { remoteAddress: socket }, headers })

describe('the visitor behind the front door', () => {
  it('reads Caddy’s last X-Forwarded-For entry, only from the proxy beside the app', () => {
    const ip = clientIpFor('caddy')
    expect(ip(req('172.18.0.3', { 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7')
    // A visitor's own claim sits before Caddy's entry and is not taken.
    expect(ip(req('172.18.0.3', { 'x-forwarded-for': '10.9.9.9, 203.0.113.7' }))).toBe(
      '203.0.113.7'
    )
    // Straight to the socket from outside: the header is not believed.
    expect(ip(req('198.51.100.4', { 'x-forwarded-for': '203.0.113.7' }))).toBe('198.51.100.4')
  })

  it('reads the Worker’s header behind the tunnel, and nothing else', () => {
    const ip = clientIpFor('cloudflare')
    expect(ip(req('::ffff:172.18.0.4', { 'x-ohsms-client-ip': '2001:db8::5' }))).toBe('2001:db8::5')
    expect(ip(req('172.18.0.4', { 'x-forwarded-for': '203.0.113.7' }))).toBe('172.18.0.4')
    expect(ip(req('172.18.0.4', { 'x-ohsms-client-ip': 'not an address; drop table' }))).toBe(
      '172.18.0.4'
    )
  })

  it('keeps the socket’s address with no front door named', () => {
    expect(clientIpFor('')(req('172.18.0.3', { 'x-forwarded-for': '203.0.113.7' }))).toBe(
      '172.18.0.3'
    )
  })

  it('knows a private address', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.1.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    for (const a of ['172.32.0.1', '8.8.8.8', '2001:db8::1', ''])
      expect(isPrivateAddress(a), a).toBe(false)
  })
})

describe('sign-in limits behind Caddy', () => {
  it('stop the stranger, not the whole organization', async () => {
    const ADMIN = { email: 'ana@example.test', password: 'first-admin-pass-1' }
    const { server } = await createDedicatedApp({
      db: openSqlite(),
      origin: 'https://ehs.example.test',
      sessionSecret: 's'.repeat(40),
      dataKeyMaster: Buffer.alloc(32, 1).toString('base64'),
      bootstrap: {
        orgName: 'Test',
        adminEmail: ADMIN.email,
        adminPassword: ADMIN.password,
        mustChange: false,
      },
      clientIp: clientIpFor('caddy'),
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const signIn = (body, from) =>
      fetch(`${base}/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
        body: JSON.stringify(body),
      })
    try {
      for (let i = 0; i < MAX_FAILURES_PER_SOURCE; i++) {
        await signIn({ email: `nobody${i}@example.test`, password: 'Password123!' }, '203.0.113.66')
      }
      expect((await signIn(ADMIN, '203.0.113.66')).status).toBe(429)
      // Same proxy, another visitor: unaffected.
      expect((await signIn(ADMIN, '198.51.100.20')).status).toBe(200)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
