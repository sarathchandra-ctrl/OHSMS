import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { applySchema, asWorker, createEngine } from '../../../stack/engine.mjs'
import { initializeOrganization } from '../../../stack/setup.mjs'
import { establishIdentity } from '../../../stack/identity.mjs'

const WORKER = { role: 'ohsms_worker', uid: '' }

async function invited() {
  const db = new PGlite()
  await applySchema(db)
  const engine = createEngine(db)
  await engine.commit(WORKER, [
    { type: 'set', path: 'organization', id: 'profile', merge: false, data: { name: 'Keel Works' } },
  ])
  await asWorker(
    db,
    "INSERT INTO invites (email, role, name) VALUES ('ana@keel.test', 'admin', 'Ana')"
  )
  return { db, engine }
}

describe('first sign-in claims the invite once', () => {
  it('lets two simultaneous sign-ins on one invite make one member, not two', async () => {
    const { db, engine } = await invited()
    const results = await Promise.all([
      establishIdentity(engine, db, { sub: 'idp|ana', email: 'Ana@Keel.test', name: 'Ana' }),
      establishIdentity(engine, db, { sub: 'idp|ana-2', email: 'ana@keel.test', name: 'Ana' }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const users = await asWorker(db, "SELECT id FROM documents WHERE path = 'users'")
    expect(users.rows).toHaveLength(1)
    const left = await asWorker(db, 'SELECT email FROM invites')
    expect(left.rows).toHaveLength(0)
  })

  it('refuses a second identity on an invite the first one already used', async () => {
    const { db, engine } = await invited()
    await establishIdentity(engine, db, { sub: 'idp|ana', email: 'ana@keel.test' })
    const other = await establishIdentity(engine, db, {
      sub: 'idp|mallory',
      email: 'ana@keel.test',
    })
    expect(other).toEqual({ ok: false, reason: 'no-invite' })
  })
})

describe('creating the organization', () => {
  it('makes one organization and invites its first administrator', async () => {
    const db = new PGlite()
    await applySchema(db)
    const engine = createEngine(db)
    const made = await initializeOrganization({
      engine,
      db,
      orgName: 'Keel Works',
      adminEmail: 'Ana@Keel.test',
      adminName: 'Ana',
    })
    expect(made).toEqual({ ok: true })
    expect(await engine.get(WORKER, 'organization', 'profile')).toMatchObject({ name: 'Keel Works' })
    const invite = await asWorker(db, 'SELECT email, role FROM invites')
    expect(invite.rows).toEqual([{ email: 'ana@keel.test', role: 'admin' }])
    const again = await initializeOrganization({
      engine,
      db,
      orgName: 'Someone Else',
      adminEmail: 'eve@evil.test',
    })
    expect(again).toEqual({ ok: false, reason: 'already-live' })
    const after = await asWorker(db, 'SELECT email FROM invites')
    expect(after.rows).toEqual([{ email: 'ana@keel.test' }])
  })

  it('refuses a missing name or a malformed administrator address', async () => {
    const db = new PGlite()
    await applySchema(db)
    const engine = createEngine(db)
    expect(await initializeOrganization({ engine, db, orgName: '', adminEmail: 'a@b.test' })).toEqual({
      ok: false,
      reason: 'orgName',
    })
    expect(await initializeOrganization({ engine, db, orgName: 'Keel', adminEmail: 'nope' })).toEqual({
      ok: false,
      reason: 'adminEmail',
    })
  })
})

describe('invite addresses', () => {
  it('takes an ordinary address and refuses empty domain labels', async () => {
    const { normalizeEmail } = await import('../../../stack/invites.mjs')
    expect(normalizeEmail(' Ana@Keel.Test ')).toBe('ana@keel.test')
    expect(normalizeEmail('ana@mail.keel.co.in')).toBe('ana@mail.keel.co.in')
    for (const bad of ['a@b..test', 'a@.b.test', 'a@b.test.', 'a@b', ['a@b.test']]) {
      expect(normalizeEmail(bad)).toBe('')
    }
  })
})
