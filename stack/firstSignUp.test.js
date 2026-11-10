import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { applySchema, createEngine } from './engine.mjs'
import { bootstrapOrganization, firstSignUp, firstSignUpOpen, signInWithPassword } from './passwords.mjs'

// The first sign-up makes its user the administrator of the whole
// installation, so each case is someone trying to be that user when they
// should not be.
let db
let engine
const owner = { orgName: 'Cult Fit', name: 'Asha Rao', email: 'Asha@Example.com', password: 'a-long-password-1' }

beforeEach(async () => {
  db = openSqlite()
  await applySchema(db)
  engine = createEngine(db)
})

describe('the first sign-up', () => {
  it('is open on an empty installation and makes its user the administrator', async () => {
    expect(await firstSignUpOpen(db)).toBe(true)
    const r = await firstSignUp(engine, db, owner)
    expect(r).toMatchObject({ ok: true, email: 'asha@example.com' })
    const user = await engine.get(null, 'users', r.uid)
    expect(user).toMatchObject({ role: 'admin', status: 'approved', mustChangePassword: false, name: 'Asha Rao' })
    expect(await engine.get(null, 'organization', 'profile')).toMatchObject({ name: 'Cult Fit' })
    // And they can sign in with what they chose.
    expect(await signInWithPassword(engine, db, { email: 'asha@example.com', password: owner.password })).toMatchObject({ ok: true })
  })

  it('closes for good once anyone exists', async () => {
    await firstSignUp(engine, db, owner)
    expect(await firstSignUpOpen(db)).toBe(false)
    expect(await firstSignUp(engine, db, { ...owner, email: 'mallory@example.com' })).toEqual({ ok: false, reason: 'closed' })
  })

  it('is closed when the operator already created the administrator', async () => {
    await bootstrapOrganization(engine, db, { orgName: 'Cult Fit', adminEmail: 'ops@example.com', adminPassword: 'operator-pass-1' })
    expect(await firstSignUpOpen(db)).toBe(false)
    expect((await firstSignUp(engine, db, owner)).reason).toBe('closed')
  })

  it('lets exactly one of two simultaneous sign-ups through', async () => {
    const results = await Promise.all(
      ['a@example.com', 'b@example.com', 'c@example.com'].map((email) => firstSignUp(engine, db, { ...owner, email }))
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const admins = await engine.list(null, 'users', {})
    expect(admins).toHaveLength(1)
  })

  it('refuses a bad address, a weak password, or no name, and stays open', async () => {
    for (const [patch, reason] of [
      [{ email: 'not-an-email' }, 'email'],
      [{ password: 'short' }, 'policy'],
      [{ name: '  ' }, 'name'],
      [{ orgName: '' }, 'org'],
    ]) {
      expect((await firstSignUp(engine, db, { ...owner, ...patch })).reason).toBe(reason)
    }
    expect(await firstSignUpOpen(db)).toBe(true)
  })

  it('asks for the setup code when the operator set one', async () => {
    const setupCode = 'k7Qp2-setup'
    for (const code of [undefined, '', 'wrong', 'k7Qp2-setu']) {
      expect((await firstSignUp(engine, db, { ...owner, code, setupCode })).reason).toBe('setup-code')
    }
    expect((await firstSignUp(engine, db, { ...owner, code: setupCode, setupCode })).ok).toBe(true)
  })
})
