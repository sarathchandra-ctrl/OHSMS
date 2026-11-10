import { describe, expect, it, vi } from 'vitest'

vi.mock('../shared/runtimeConfig', () => ({
  runtimeEnv: (name) => (name === 'DATA_GATEWAY' ? 'https://demo.invalid' : ''),
}))

const { demoResponse, demoToken, DEMO_ACCOUNTS } = await import('./demoMode')
const post = (path, body) =>
  demoResponse(`https://demo.invalid${path}`, { method: 'POST', body: JSON.stringify(body) })

describe('demo gateway', () => {
  it('signs in the listed accounts only', async () => {
    const admin = DEMO_ACCOUNTS[0]
    const ok = await post('/auth/password', { email: admin.email, password: admin.password })
    expect(ok.status).toBe(200)
    const { token } = await ok.json()
    expect(JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub).toBe(admin.uid)
    expect((await post('/auth/password', { email: admin.email, password: 'guess' })).status).toBe(401)
  })

  it('leaves every other URL to the real fetch', async () => {
    expect(await demoResponse('https://tile.openstreetmap.org/1/1/1.png', {})).toBeNull()
  })

  it('says plainly when a feature needs the real server', async () => {
    const res = await post('/rpc/exportSubjectData', {})
    expect(res.status).toBe(503)
  })

  it('mints a token that expires', () => {
    const exp = JSON.parse(atob(demoToken('x', 0).split('.')[1])).exp
    expect(exp).toBe(8 * 3600)
  })
})
