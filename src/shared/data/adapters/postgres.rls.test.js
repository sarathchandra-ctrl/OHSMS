import { describe, expect, it, beforeAll } from 'vitest'
import { openSqlite } from '../../../../stack/sqlite.mjs'
import { applySchema, createEngine } from '../../../../stack/engine.mjs'
import { createPostgresAdapter } from './postgres'

// The access rules, through the real engine and the app's own data client.
// SQLite has no row-level security: every rule here is stack/policy.mjs,
// asked by stack/engine.mjs before any SQL runs. Each case tries the hostile
// version of the write, not the well-behaved one.
const db = openSqlite()
const engine = createEngine(db)
const adminEngine = engine

const browser = (uid) => ({ role: 'ohsms_browser', uid })
const as = (uid) => createPostgresAdapter(engine, browser(uid))

async function seed(path, id, data) {
  await adminEngine.commit(null, [{ type: 'set', path, id, data, merge: false }])
}

beforeAll(async () => {
  await applySchema(db)
  await seed('users', 'adminA', { role: 'admin', status: 'approved', name: 'Ada' })
  await seed('users', 'memberA', { role: 'member', status: 'approved', name: 'Mo' })
  await seed('users', 'managerA', { role: 'manager', status: 'approved', name: 'Mia' })
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
  await seed('auditLogs', 'log1', { action: 'create', actorUid: 'adminA' })
  await seed('meta', 'docSeq', { n: 5 })
  await seed('meta', 'cryptoKeys', { general: { wrappedKey: 'secret' } })
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

  it('does not let an auditor delete or change a record, and lets them log', async () => {
    const auditor = as('auditorA')
    await expect(auditor.remove('incidents', 'i1')).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(auditor.update('incidents', 'i1', { title: 'x' })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    await expect(auditor.set('incidents', 'new', { title: 'x' })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    expect(await adminEngine.get(null, 'incidents', 'i1')).toMatchObject({ title: 'Cut' })
    // The one thing an auditor writes: the trail, in their own name only.
    await auditor.set('auditLogs', 'mine', { action: 'export', actorUid: 'auditorA' })
    await expect(
      auditor.set('auditLogs', 'forged', { action: 'export', actorUid: 'adminA' })
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('keeps the audit log append-only, admin included', async () => {
    const admin = as('adminA')
    await expect(admin.update('auditLogs', 'log1', { action: 'nothing' })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    await expect(admin.remove('auditLogs', 'log1')).rejects.toMatchObject({ code: 'permission-denied' })
    expect(await adminEngine.get(null, 'auditLogs', 'log1')).toMatchObject({ action: 'create' })
  })

  it('never lets reference numbers run backwards', async () => {
    const member = as('memberA')
    await expect(member.set('meta', 'docSeq', { n: 0 }, { merge: true })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    await member.update('meta', 'docSeq', { n: 6 })
    expect((await adminEngine.get(null, 'meta', 'docSeq')).n).toBe(6)
  })

  it('keeps the encryption keys out of reach of every browser session', async () => {
    const admin = as('adminA')
    expect(await admin.get('meta', 'cryptoKeys')).toBeNull()
    expect((await admin.list('meta')).map((d) => d.id)).not.toContain('cryptoKeys')
    await expect(admin.set('meta', 'cryptoKeys', { general: {} })).rejects.toThrow()
    expect((await adminEngine.get(null, 'meta', 'cryptoKeys')).general.wrappedKey).toBe('secret')
  })

  it('refuses to overwrite a record the caller cannot see', async () => {
    const member = as('memberA')
    await expect(member.set('injuries', 'inj1', { status: 'open', name: 'x' })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    expect((await adminEngine.get(null, 'injuries', 'inj1')).name).toBe('Mo')
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

describe('restrictions are added to every allow, not offered as one more', () => {
  it('an auditor is approved, and still cannot delete', async () => {
    // Approved managers may delete records; the auditor restriction must win
    // over that broad allow. Reversing the order of those two checks is the
    // permissive-union bug.
    await adminEngine.commit(null, [{ type: 'set', path: 'incidents', id: 'i9', data: { title: 'x' }, merge: false }])
    await expect(as('auditorA').remove('incidents', 'i9')).rejects.toMatchObject({ code: 'permission-denied' })
    await as('managerA').remove('incidents', 'i9')
    expect(await adminEngine.get(null, 'incidents', 'i9')).toBeNull()
  })
})

// An employee creates, views and closes. Approving, verifying and deleting
// are a manager's. Each case is the write an employee would send to skip that.
describe('employee: create, view and close only', () => {
  beforeAll(async () => {
    await seed('permits', 'p-pend', { status: 'pending_approval', title: 'Hot work' })
    await seed('permits', 'p-ok', { status: 'approved', title: 'Roof' })
    await seed('reports', 'r1', { approvalStatus: 'pending', kind: 'defect' })
    await seed('incidents', 'i-close', { title: 'Slip', lifecycle: 'open' })
    await seed('incidents', 'i-del', { title: 'Trip', createdBy: 'memberA' })
    await seed('sites', 's-1', { name: 'Depot', region: 'North' })
    await seed('trainingRequests', 'tr-mine', { employeeUid: 'memberA', status: 'pending' })
    await seed('trainingRequests', 'tr-theirs', { employeeUid: 'adminA', status: 'pending' })
    await seed('trainingRequests', 'tr-named', { employeeUid: 'Mo', status: 'pending' })
    await seed('defectLocks', 'ext1__crack', { extId: 'ext1', defectType: 'crack' })
    await seed('incidents/i-close/photos', 'ph1', { url: 'x' })
  })
  const denied = { code: 'permission-denied' }

  it('lets an employee raise and submit, but not approve', async () => {
    const m = as('memberA')
    await m.set('permits', 'p-new', { status: 'draft', title: 'Mine' })
    await m.update('permits', 'p-new', { status: 'pending_approval' })
    // Every way into a decided state: directly, on create, per approver, and by clearing one.
    await expect(m.update('permits', 'p-pend', { status: 'approved' })).rejects.toMatchObject(denied)
    await expect(m.set('permits', 'p-skip', { status: 'approved' })).rejects.toMatchObject(denied)
    await expect(
      m.update('permits', 'p-pend', { engineering: { status: 'approved' } })
    ).rejects.toMatchObject(denied)
    await expect(m.update('permits', 'p-ok', { status: 'pending_approval' })).rejects.toMatchObject(denied)
    await expect(m.update('reports', 'r1', { approvalStatus: 'approved' })).rejects.toMatchObject(denied)
    await expect(m.update('incidents', 'i-close', { lifecycle: 'verified' })).rejects.toMatchObject(denied)
    expect((await adminEngine.get(null, 'permits', 'p-pend')).status).toBe('pending_approval')
    expect((await adminEngine.get(null, 'permits', 'p-ok')).status).toBe('approved')

    await as('managerA').update('permits', 'p-pend', { status: 'approved' })
    expect((await adminEngine.get(null, 'permits', 'p-pend')).status).toBe('approved')
  })

  it('lets an employee close', async () => {
    await as('memberA').update('incidents', 'i-close', { lifecycle: 'closed' })
    expect((await adminEngine.get(null, 'incidents', 'i-close')).lifecycle).toBe('closed')
  })

  it('refuses an employee every delete, their own record and its photos included', async () => {
    const m = as('memberA')
    await expect(m.remove('incidents', 'i1')).rejects.toMatchObject(denied)
    await expect(m.remove('incidents', 'i-del')).rejects.toMatchObject(denied)
    await expect(m.remove('incidents/i-close/photos', 'ph1')).rejects.toMatchObject(denied)
    await expect(m.remove('permits', 'p-ok')).rejects.toMatchObject(denied)
    await expect(m.remove('meta', 'docSeq')).rejects.toMatchObject(denied)
    await expect(m.remove('qr', 'tok1')).rejects.toMatchObject(denied)
    expect(await adminEngine.get(null, 'incidents', 'i-del')).not.toBeNull()
    expect(await adminEngine.get(null, 'meta', 'docSeq')).not.toBeNull()
  })

  it('lets an employee withdraw only their own training request, matched by uid', async () => {
    const m = as('memberA')
    await expect(m.remove('trainingRequests', 'tr-theirs')).rejects.toMatchObject(denied)
    // A field holding the person's display name is not ownership.
    await expect(m.remove('trainingRequests', 'tr-named')).rejects.toMatchObject(denied)
    await m.remove('trainingRequests', 'tr-mine')
    expect(await adminEngine.get(null, 'trainingRequests', 'tr-mine')).toBeNull()
    await m.remove('defectLocks', 'ext1__crack')
  })

  it('leaves the site register to managers', async () => {
    const m = as('memberA')
    await expect(m.update('sites', 's-1', { region: 'South' })).rejects.toMatchObject(denied)
    await expect(m.set('sites', 's-2', { name: 'Mine' })).rejects.toMatchObject(denied)
    await expect(m.remove('sites', 's-1')).rejects.toMatchObject(denied)
    expect((await adminEngine.get(null, 'sites', 's-1')).region).toBe('North')

    const mgr = as('managerA')
    await mgr.update('sites', 's-1', { region: 'South' })
    await mgr.remove('incidents', 'i-del')
    expect(await adminEngine.get(null, 'incidents', 'i-del')).toBeNull()
  })
})
