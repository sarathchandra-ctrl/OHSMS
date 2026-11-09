import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { applySchema, createEngine } from '../../../../stack/engine.mjs'
import { createPostgresAdapter } from './postgres'

// Embedded by default. With OHSMS_TEST_PG_URL (an ordinary login role, the
// shape a managed Postgres gives you) and OHSMS_TEST_PG_ADMIN_URL (a role
// that bypasses RLS, for seeding and for reading back what really happened),
// the same assertions run on a real Postgres. Embedded runs as superuser, and
// that hid a bug: the SECURITY DEFINER helpers recursed on every member read
// once their owner was an ordinary role (stack/schema.sql). docs/CONTROL-PLANE.md.
const PG_URL = process.env.OHSMS_TEST_PG_URL
const PG_ADMIN_URL = process.env.OHSMS_TEST_PG_ADMIN_URL
const onPg = Boolean(PG_URL && PG_ADMIN_URL)
const { createPgDatabase } = onPg ? await import('../../../../stack/pg.mjs') : {}

/** The app's own connection: what the gateway uses. */
const db = onPg ? createPgDatabase(PG_URL) : new PGlite()
const engine = createEngine(db)
/** Seeding and read-back, past RLS. On embedded, the same superuser handle. */
const admin = onPg ? createPgDatabase(PG_ADMIN_URL) : db
const adminEngine = onPg ? createEngine(admin) : engine

const browser = (uid) => ({ role: 'ohsms_browser', uid })
const as = (uid) => createPostgresAdapter(engine, browser(uid))

async function seed(path, id, data) {
  await adminEngine.commit(null, [{ type: 'set', path, id, data, merge: false }])
}

afterAll(async () => {
  if (onPg) await Promise.all([db.end(), admin.end()])
})

beforeAll(async () => {
  await applySchema(db)
  if (onPg) await admin.exec('TRUNCATE documents, files, policy_union, auth_secrets, invites')
  await seed('users', 'adminA', { role: 'admin', status: 'approved', name: 'Ada' })
  await seed('users', 'memberA', { role: 'member', status: 'approved', name: 'Mo' })
  await seed('users', 'auditorA', {
    role: 'auditor',
    status: 'approved',
    name: 'Aud',
  })
  await seed('users', 'pendingA', { role: 'member', status: 'pending', name: 'Pat' })
  await seed('users', 'disabledA', { role: 'manager', status: 'disabled', name: 'Dee' })
  await seed('organization', 'profile', { name: 'Keel Works' })
  await seed('scimTokens', 'current', { hash: 'secret-hash' })
  await seed('users', 'flaggedA', {
    role: 'manager',
    status: 'approved',
    mustChangePassword: true,
    name: 'Temp',
  })
  await seed('incidents', 'i1', { title: 'Cut' })
  await seed('injuries', 'inj1', { status: 'open', name: 'Mo' })
  await seed('qr', 'tok1', { extId: 'ext1', token: 'tok1' })
  await seed('permitQr', 'ptok', { permitId: 'p1', token: 'ptok' })
  await admin.query(`INSERT INTO files (path) VALUES ('files/photos/a.jpg')`)
  await admin.query(`INSERT INTO policy_union (id) VALUES ('row1')`)
})

describe('who belongs', () => {
  it('shows nothing to a signed-out caller, a pending member or a disabled one', async () => {
    for (const uid of ['', 'stranger', 'pendingA', 'disabledA']) {
      const who = as(uid)
      expect(await who.get('incidents', 'i1'), uid).toBeNull()
      expect(await who.list('incidents'), uid).toEqual([])
      expect(await who.get('organization', 'profile'), uid).toBeNull()
      await expect(who.set('incidents', `sneak-${uid}`, { title: 'no' })).rejects.toMatchObject({
        code: 'permission-denied',
      })
    }
    // A pending member still reads their own profile, to see the waiting room.
    expect(await as('pendingA').get('users', 'pendingA')).toMatchObject({ status: 'pending' })
    expect(await as('pendingA').get('users', 'adminA')).toBeNull()
  })

  it('lets an approved member read the records and the people', async () => {
    const member = as('memberA')
    expect(await member.get('incidents', 'i1')).toMatchObject({ title: 'Cut' })
    expect(await member.get('organization', 'profile')).toMatchObject({ name: 'Keel Works' })
    expect((await member.list('users')).length).toBeGreaterThan(1)
  })

  it('keeps the directory token out of the data API, admin included', async () => {
    const adminA = as('adminA')
    expect(await adminA.get('scimTokens', 'current')).toBeNull()
    await expect(adminA.set('scimTokens', 'current', { hash: 'mine' })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    expect((await adminEngine.get(null, 'scimTokens', 'current')).hash).toBe('secret-hash')
  })

  it('leaves the organization settings and modules to an administrator', async () => {
    const member = as('memberA')
    // The row is not updatable for them, so the update finds nothing to change.
    await expect(member.update('organization', 'profile', { name: 'Hijacked' })).rejects.toThrow()
    await expect(
      member.set('moduleEntitlements', 'organization', { modules: { loto: false } })
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await adminEngine.get(null, 'organization', 'profile')).name).toBe('Keel Works')

    const adminA = as('adminA')
    await adminA.update('organization', 'profile', { address: 'Pune' })
    await adminA.set('moduleEntitlements', 'organization', { modules: { loto: false } })
    expect((await adminEngine.get(null, 'organization', 'profile')).address).toBe('Pune')
    expect((await adminEngine.get(null, 'moduleEntitlements', 'organization')).modules.loto).toBe(
      false
    )
  })
})

describe('roles', () => {
  it('refuses a member the manager decision on an injury', async () => {
    const member = as('memberA')
    // The row is invisible, not an empty module the caller could mistake for "no injuries".
    expect(await member.get('injuries', 'inj1')).toBeNull()
    // The row is hidden, so the update does not see it. Writing a verified
    // injury under a new id is the way a member would skip the queue, and
    // that insert is the one the trigger has to refuse.
    await expect(
      member.set('injuries', 'inj-new', { status: 'verified' })
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await adminEngine.get(null, 'injuries', 'inj1')).status).toBe('open')

    const admin = as('adminA')
    expect(await admin.get('injuries', 'inj1')).toMatchObject({ status: 'open' })
    await admin.update('injuries', 'inj1', { status: 'verified' })
    expect((await adminEngine.get(null, 'injuries', 'inj1')).status).toBe(
      'verified'
    )
  })

  it('does not let an auditor delete a document or a file', async () => {
    const auditor = as('auditorA')
    await expect(auditor.remove('incidents', 'i1')).rejects.toMatchObject({
      code: 'permission-denied',
    })
    expect(await adminEngine.get(null, 'incidents', 'i1')).toMatchObject({
      title: 'Cut',
    })

    const fileDelete = await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE ohsms_browser')
      await tx.query(`SELECT set_config('app.uid', 'auditorA', true)`)
      return tx.query(`DELETE FROM files WHERE path = 'files/photos/a.jpg'`)
    })
    expect(fileDelete.affectedRows).toBe(0)
    const still = await admin.query(`SELECT path FROM files WHERE path = 'files/photos/a.jpg'`)
    expect(still.rows).toHaveLength(1)
  })

  it('lets a manager delete a stored file, and not a member or a path outside files/', async () => {
    await admin.query(
      `INSERT INTO files (path) VALUES ('files/photos/b.jpg'), ('files/photos/c.jpg'), ('other/d.jpg') ON CONFLICT DO NOTHING`
    )
    const del = (uid, path) =>
      db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE ohsms_browser')
        await tx.query(`SELECT set_config('app.uid', '${uid}', true)`)
        return (await tx.query(`DELETE FROM files WHERE path = '${path}'`)).affectedRows
      })
    expect(await del('memberA', 'files/photos/c.jpg')).toBe(0)
    expect(await del('adminA', 'files/photos/b.jpg')).toBe(1)
    expect(await del('adminA', 'other/d.jpg')).toBe(0)
    const left = await admin.query(`SELECT path FROM files WHERE path IN ('files/photos/c.jpg', 'other/d.jpg')`)
    expect(left.rows).toHaveLength(2)
  })
})

describe('anonymous token-bound writes', () => {
  const anon = as('')

  it('refuses a report that does not carry a live token for that asset', async () => {
    await expect(
      anon.create('reports', {
        source: 'qr',
        approvalStatus: 'pending',
        reportedBy: 'public',
        kind: 'defect',
        extId: 'ext1',
        token: 'missing',
      })
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('accepts a report whose token names that asset', async () => {
    const id = await anon.create('reports', {
      source: 'qr',
      approvalStatus: 'pending',
      reportedBy: 'public',
      kind: 'defect',
      extId: 'ext1',
      token: 'tok1',
    })
    expect(await adminEngine.get(null, 'reports', id)).toMatchObject({
      extId: 'ext1',
    })
  })

  it('refuses the same token against a different asset', async () => {
    await expect(
      anon.create('reports', {
        source: 'qr',
        approvalStatus: 'pending',
        reportedBy: 'public',
        kind: 'defect',
        extId: 'ext-other',
        token: 'tok1',
      })
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })
})

describe('post-state check', () => {
  it('does not let a member grant themselves admin by writing the new role', async () => {
    const member = as('memberA')
    await expect(
      member.update('users', 'memberA', {
        role: 'admin',
        status: 'approved',
        name: 'Mo',
      })
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await adminEngine.get(null, 'users', 'memberA')).role).toBe('member')
  })

  it('does not let the password gate be cleared by the person holding it', async () => {
    const flagged = as('flaggedA')
    await expect(
      flagged.set('incidents', 'x', { title: 'no' })
    ).rejects.toMatchObject({
      code: 'permission-denied',
    })
    await expect(
      flagged.update('users', 'flaggedA', {
        role: 'manager',
        status: 'approved',
        mustChangePassword: false,
        name: 'Temp',
      })
    ).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await adminEngine.get(null, 'users', 'flaggedA')).mustChangePassword).toBe(true)
  })
})

describe('permissive union', () => {
  it('lets the narrow policy win when the broad one also matches', async () => {
    async function deleted() {
      return db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE ohsms_browser')
        await tx.query(`SELECT set_config('app.uid', 'auditorA', true)`)
        const res = await tx.query(`DELETE FROM policy_union WHERE id = 'row1'`)
        return res.affectedRows
      })
    }
    // Both policies match an approved auditor. The restrictive one wins, so
    // the broad grant removes nothing.
    expect(await deleted()).toBe(0)
    expect(await admin.query(`SELECT id FROM policy_union WHERE id = 'row1'`)).toMatchObject({
      rows: [{ id: 'row1' }],
    })

    await db.exec('DROP POLICY union_auditor_cannot_delete ON policy_union')
    expect(await deleted()).toBe(1)

    await db.exec(`CREATE POLICY union_auditor_cannot_delete ON policy_union AS RESTRICTIVE FOR DELETE TO ohsms_browser
      USING (COALESCE(app_profile()->>'role', '') <> 'auditor')`)
    await admin.query(`INSERT INTO policy_union (id) VALUES ('row1')`)
    expect(await deleted()).toBe(0)
  })
})
