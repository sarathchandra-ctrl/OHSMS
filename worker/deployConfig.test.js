import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deployConfig, parseJsonc, secretsToSet, settingsProblems } from './deployConfig.js'

const base = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
const ok = { CLOUDFLARE_API_TOKEN: 't'.repeat(40), CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }
// A stand-in key of the right shape, generated for this test only.
const KEY = Buffer.alloc(32, 7).toString('base64')

describe('reading wrangler.jsonc', () => {
  it('keeps strings that look like comments, and drops the comments', () => {
    expect(base.rules[0].globs).toEqual(['**/*.sql'])
    expect(base.name).toBe('ohsms')
    expect(parseJsonc('{ "u": "https://x//y", /* c */ "a": [1, 2,], // end\n }')).toEqual({
      u: 'https://x//y',
      a: [1, 2],
    })
    expect(parseJsonc('{ "q": "say \\"hi\\" // not a comment" }')).toEqual({
      q: 'say "hi" // not a comment',
    })
  })
})

describe('checking the settings before a deploy', () => {
  it('needs only the token and the account', () => {
    expect(settingsProblems(ok)).toEqual([])
    expect(settingsProblems({})).toHaveLength(2)
  })

  it('applies the server’s own start-up rules to the Worker secrets', () => {
    const problems = settingsProblems({
      ...ok,
      SESSION_SECRET: 'short',
      DATA_KEY_MASTER: 'not-a-key',
      ADMIN_PASSWORD: '123',
    })
    expect(problems.map((p) => p.split(' ')[0])).toEqual([
      'SESSION_SECRET',
      'DATA_KEY_MASTER',
      'ADMIN_PASSWORD',
    ])
    expect(
      settingsProblems({
        ...ok,
        SESSION_SECRET: 's'.repeat(64),
        DATA_KEY_MASTER: KEY,
        ADMIN_PASSWORD: 'long-enough-1',
      })
    ).toEqual([])
  })

  it('names a bad setting, never its value', () => {
    const secret = 'my-actual-password'
    const problems = settingsProblems({ ...ok, CLOUDFLARE_D1_DATABASE_ID: secret })
    expect(problems.join(' ')).not.toContain(secret)
    expect(problems[0]).toMatch(/^CLOUDFLARE_D1_DATABASE_ID /)
  })

  it('wants an origin with no path', () => {
    expect(settingsProblems({ ...ok, OHSMS_PUBLIC_ORIGIN: 'https://ehs.example.com' })).toEqual([])
    expect(settingsProblems({ ...ok, OHSMS_PUBLIC_ORIGIN: 'http://ehs.example.com' })).toHaveLength(
      1
    )
  })
})

describe('the deploy config', () => {
  it('is wrangler.jsonc unless GitHub overrides a name or id', () => {
    const same = deployConfig(base, ok)
    expect(same.d1_databases).toEqual(base.d1_databases)
    const cfg = deployConfig(base, {
      CLOUDFLARE_WORKER_NAME: 'ohsms-staging',
      CLOUDFLARE_D1_DATABASE_ID: '00000000-0000-4000-8000-000000000000',
      CLOUDFLARE_D1_DATABASE_NAME: 'ohsms-staging',
      CLOUDFLARE_R2_BUCKET_NAME: 'ohsms-staging-files',
    })
    expect(cfg.name).toBe('ohsms-staging')
    expect(cfg.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: 'ohsms-staging' })
    expect(cfg.r2_buckets[0]).toEqual({ binding: 'FILES', bucket_name: 'ohsms-staging-files' })
    expect(cfg.keep_vars).toBe(true)
    expect(base.name).toBe('ohsms')
  })
})

describe('Worker secrets', () => {
  it('sets only what the Worker does not already have, never a replacement', () => {
    const env = { SESSION_SECRET: 's'.repeat(64), DATA_KEY_MASTER: KEY, ADMIN_PASSWORD: '' }
    expect(Object.keys(secretsToSet(env, []))).toEqual(['SESSION_SECRET', 'DATA_KEY_MASTER'])
    expect(secretsToSet(env, ['DATA_KEY_MASTER', 'SESSION_SECRET'])).toEqual({})
    expect(Object.keys(secretsToSet(env, ['DATA_KEY_MASTER']))).toEqual(['SESSION_SECRET'])
  })
})
