import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { applySchema, createEngine } from './engine.mjs'
import {
  MAX_FAILURES,
  MAX_FAILURES_PER_SOURCE,
  RESETS_PER_SOURCE_HOUR,
  bootstrapOrganization,
  requestPasswordReset,
  signInWithPassword,
} from './passwords.mjs'

// The sign-in and reset limits, driven the way an attacker would drive them.
const ADMIN = { email: 'ana@example.test', password: 'first-admin-pass-1' }
let engine
let db

beforeEach(async () => {
  db = openSqlite()
  await applySchema(db)
  engine = createEngine(db)
  await bootstrapOrganization(engine, db, {
    orgName: 'Test',
    adminEmail: ADMIN.email,
    adminPassword: ADMIN.password,
    mustChange: false,
  })
})

const signIn = (password, ip, email = ADMIN.email) => signInWithPassword(engine, db, { email, password, ip })

describe('sign-in limits', () => {
  it('locks an address for the source guessing at it, and not for the person', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await signIn(`wrong-${i}`, '203.0.113.9')
    // The stranger is locked out, even with the right password...
    expect((await signIn(ADMIN.password, '203.0.113.9')).reason).toBe('locked')
    // ...and the person, from their own machine, is not.
    expect(await signIn(ADMIN.password, '198.51.100.4')).toMatchObject({ ok: true })
  })

  it('stops one source spraying passwords across many addresses', async () => {
    const ip = '203.0.113.50'
    for (let i = 0; i < MAX_FAILURES_PER_SOURCE; i++) {
      await signIn('Password123!', ip, `person${i}@example.test`)
    }
    // Now refused before the password is even checked, right one included.
    expect((await signIn(ADMIN.password, ip)).reason).toBe('throttled')
    expect(await signIn(ADMIN.password, '198.51.100.4')).toMatchObject({ ok: true })
  })

  it('still bounds guessing one address from many machines', async () => {
    for (let i = 0; i < 100; i++) await signIn(`wrong-${i}`, `10.0.${Math.floor(i / 9)}.${i % 9}`)
    expect((await signIn(ADMIN.password, '198.51.100.4')).reason).toBe('locked')
  })
})

describe('password reset limits', () => {
  it('caps the mails one source can trigger, across addresses', async () => {
    const sent = []
    const send = async (m) => sent.push(m)
    const ip = '203.0.113.77'
    for (let i = 0; i < RESETS_PER_SOURCE_HOUR; i++) {
      await requestPasswordReset(engine, db, { email: `nobody${i}@example.test`, origin: 'https://x.test', send, ip })
    }
    await requestPasswordReset(engine, db, { email: ADMIN.email, origin: 'https://x.test', send, ip })
    expect(sent).toEqual([])
    // Another source still gets its mail.
    await requestPasswordReset(engine, db, {
      email: ADMIN.email,
      origin: 'https://x.test',
      send,
      ip: '198.51.100.4',
    })
    expect(sent.map((m) => m.to)).toEqual([ADMIN.email])
  })
})
