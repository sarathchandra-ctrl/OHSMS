import { describe, expect, it, beforeAll } from 'vitest'
import { openSqlite } from '../../../../stack/sqlite.mjs'
import { applySchema, createEngine } from '../../../../stack/engine.mjs'
import { createPostgresAdapter } from './postgres'
import { mirrorDisplayFields } from '../../../modules/ptw/lib/publicPermit'
import { answerBlock } from '../../../modules/ptw/lib/rejection'

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
  // Posted to s-1 and granted s-9: the sites the fixtures below name.
  await seed('users', 'memberA', {
    role: 'member',
    status: 'approved',
    name: 'Mo',
    siteId: 's-1',
    access: { sites: ['s-9'] },
  })
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

  it('keeps third-party credentials out of the data API, admin included', async () => {
    await seed('integrations', 'metabase', { baseUrl: 'https://bi.example.test', apiKey: 'mb-secret' })
    for (const uid of ['memberA', 'adminA']) {
      expect(await as(uid).get('integrations', 'metabase'), uid).toBeNull()
      expect(await as(uid).list('integrations'), uid).toEqual([])
      await expect(as(uid).set('integrations', 'metabase', { apiKey: 'swapped' }, { merge: true })).rejects.toThrow()
    }
    expect((await adminEngine.get(null, 'integrations', 'metabase')).apiKey).toBe('mb-secret')
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

// Editing, for an employee: their own rows, the equipment registers, a close,
// and the status of an action in a list. Not anyone else's record.
describe('employee: edits', () => {
  beforeAll(async () => {
    await seed('incidents', 'e-theirs', {
      title: 'Fall',
      lifecycle: 'open',
      createdBy: 'adminA',
      capa: [
        { id: 'a1', description: 'Fix rail', status: 'open', owner: 'Mo' },
        { id: 'a2', description: 'Train crew', status: 'open', owner: 'Ada' },
      ],
    })
    await seed('incidents', 'e-mine', { title: 'Mine', createdBy: 'memberA' })
    await seed('incidents', 'e-named', { title: 'Named', createdBy: 'Mo' })
    await seed('extinguishers', 'x1', { status: 'ok', siteId: 's-1' })
  })
  const denied = { code: 'permission-denied' }

  it('refuses rewriting or blanking a record someone else created', async () => {
    const m = as('memberA')
    await expect(m.update('incidents', 'e-theirs', { title: 'Nothing happened' })).rejects.toMatchObject(denied)
    await expect(m.set('incidents', 'e-theirs', {}, { merge: false })).rejects.toMatchObject(denied)
    // A name in createdBy is not ownership.
    await expect(m.update('incidents', 'e-named', { title: 'x' })).rejects.toMatchObject(denied)
    expect((await adminEngine.get(null, 'incidents', 'e-theirs')).title).toBe('Fall')
  })

  it('lets an employee edit their own record and the equipment registers', async () => {
    const m = as('memberA')
    await m.update('incidents', 'e-mine', { title: 'Mine, corrected' })
    await m.update('extinguishers', 'x1', { status: 'refilling' })
    await m.set('alertReads', 'memberA', { seen: 3 })
    expect((await adminEngine.get(null, 'extinguishers', 'x1')).status).toBe('refilling')
  })

  it('moves an action along, and nothing else about it', async () => {
    const m = as('memberA')
    const capa = (await adminEngine.get(null, 'incidents', 'e-theirs')).capa
    await m.update('incidents', 'e-theirs', {
      capa: capa.map((a) => (a.id === 'a1' ? { ...a, status: 'closed', closedAt: '2026-11-10' } : a)),
    })
    await expect(
      m.update('incidents', 'e-theirs', {
        capa: capa.map((a) => (a.id === 'a2' ? { ...a, description: 'Nothing to do' } : a)),
      })
    ).rejects.toMatchObject(denied)
    await expect(m.update('incidents', 'e-theirs', { capa: [capa[0]] })).rejects.toMatchObject(denied)
  })

  it('closes a record, but a close cannot carry a rewrite with it', async () => {
    const m = as('memberA')
    await expect(
      m.update('incidents', 'e-theirs', { lifecycle: 'closed', title: 'Nothing happened' })
    ).rejects.toMatchObject(denied)
    // Not while its actions are open (actions-open); the employee closes those first.
    await expect(m.update('incidents', 'e-theirs', { lifecycle: 'closed' })).rejects.toMatchObject(denied)
    const row0 = await adminEngine.get(null, 'incidents', 'e-theirs')
    await m.update('incidents', 'e-theirs', {
      capa: row0.capa.map((a) => ({ ...a, status: 'closed' })),
    })
    await m.update('incidents', 'e-theirs', {
      lifecycle: 'closed',
      closedAt: '2026-11-10',
      closedBy: 'Mo',
      stagesDone: { horizontal: true },
    })
    const row = await adminEngine.get(null, 'incidents', 'e-theirs')
    expect(row).toMatchObject({ lifecycle: 'closed', title: 'Fall' })
    // Re-opening is an edit, not a close.
    await expect(m.update('incidents', 'e-theirs', { lifecycle: 'open' })).rejects.toMatchObject(denied)
  })

  it('leaves a manager free to edit', async () => {
    await as('managerA').update('incidents', 'e-theirs', { title: 'Fall from height' })
    expect((await adminEngine.get(null, 'incidents', 'e-theirs')).title).toBe('Fall from height')
  })
})

// An employee given some modules reaches only those modules' collections.
// Outside them they may still report an incident (every worker can) and see
// what they themselves created — nothing else.
describe('module permission', () => {
  beforeAll(async () => {
    await seed('users', 'hiraOnly', {
      role: 'member',
      status: 'approved',
      name: 'Hana',
      access: { modules: ['hira'] },
    })
    await seed('users', 'noModules', { role: 'member', status: 'approved', access: { modules: [] } })
    await seed('users', 'mgrListed', {
      role: 'manager',
      status: 'approved',
      access: { modules: ['hira'] },
    })
    await seed('incidents', 'm-other', { title: 'Not hers', createdBy: 'adminA' })
    await seed('incidents', 'm-hers', { title: 'Hers', createdBy: 'hiraOnly' })
    await seed('incidents/m-other/photos', 'mp1', { url: 'x' })
    await seed('extinguishers', 'mx1', { status: 'ok' })
    await seed('assessments', 'ma1', { title: 'Ladder', createdBy: 'adminA' })
  })
  const denied = { code: 'permission-denied' }

  it('hides a module the employee was not given, list, get and sub-collections alike', async () => {
    const h = as('hiraOnly')
    expect(await h.get('incidents', 'm-other')).toBeNull()
    expect(await h.get('extinguishers', 'mx1')).toBeNull()
    expect((await h.list('incidents')).map((d) => d.id)).toEqual(['m-hers'])
    expect(await h.list('incidents/m-other/photos')).toEqual([])
    expect(await h.list('extinguishers')).toEqual([])
    expect(await as('noModules').list('assessments')).toEqual([])
  })

  it('refuses writes outside the granted modules', async () => {
    const h = as('hiraOnly')
    await expect(h.update('extinguishers', 'mx1', { status: 'gone' })).rejects.toThrow()
    await expect(h.set('extinguishers', 'mx2', { status: 'ok' })).rejects.toMatchObject(denied)
    await expect(h.set('permits', 'mp-new', { status: 'draft' })).rejects.toMatchObject(denied)
    await expect(h.update('incidents', 'm-hers', { title: 'Edited' })).rejects.toMatchObject(denied)
    expect((await adminEngine.get(null, 'extinguishers', 'mx1')).status).toBe('ok')
  })

  it('still lets anyone report an incident and read back their own report', async () => {
    const h = as('hiraOnly')
    await h.set('incidents', 'm-new', { title: 'Spill', createdBy: 'hiraOnly' })
    await h.set('incidents/m-new/photos', 'p1', { url: 'y' })
    expect(await h.get('incidents', 'm-new')).toMatchObject({ title: 'Spill' })
    // A report signed in from a QR is allowed exactly as an anonymous one is.
    await h.set('reports', 'qr-1', { source: 'qr', approvalStatus: 'pending', kind: 'defect' })
    await expect(
      h.set('reports', 'qr-2', { source: 'qr', approvalStatus: 'approved', kind: 'defect' })
    ).rejects.toMatchObject(denied)
  })

  it('works normally inside the granted modules', async () => {
    const h = as('hiraOnly')
    expect(await h.get('assessments', 'ma1')).toMatchObject({ title: 'Ladder' })
    await h.set('assessments', 'ma2', { title: 'Mine', createdBy: 'hiraOnly' })
  })

  it('cannot grant itself a module', async () => {
    await expect(
      as('hiraOnly').update('users', 'hiraOnly', { access: { modules: ['hira', 'incidents'] } })
    ).rejects.toMatchObject(denied)
  })

  it('does not apply to managers or to employees without a list', async () => {
    expect(await as('mgrListed').get('incidents', 'm-other')).toMatchObject({ title: 'Not hers' })
    expect(await as('memberA').get('extinguishers', 'mx1')).toMatchObject({ status: 'ok' })
  })
})

// The public QR mirrors: readable by token, without an account — and nothing
// more. The token is the capability; a list would hand out all of them.
describe('public QR mirrors', () => {
  beforeAll(async () => {
    await seed('qr', 'tok-a', { extId: 'x1', token: 'tok-a', status: 'active' })
    await seed('permitQr', 'ptok-a', { permitId: 'p1', token: 'ptok-a', site: 'Bay 3' })
    await seed('procedureQr', 'proc-a', { title: 'Isolate pump', points: [] })
    await seed('qr', 'tok-legacy', { extId: 'x2', token: 'tok-legacy', legacyNote: 'from before' })
  })
  const denied = { code: 'permission-denied' }

  it('answers a get by token and refuses every list, signed in or not', async () => {
    for (const uid of ['', 'memberA', 'adminA']) {
      const who = as(uid)
      expect(await who.get('qr', 'tok-a'), uid).toMatchObject({ status: 'active' })
      expect(await who.list('qr'), uid).toEqual([])
      expect(await who.list('permitQr'), uid).toEqual([])
      expect(await who.list('procedureQr'), uid).toEqual([])
    }
  })

  it('refuses a field the mirror builders never write', async () => {
    const m = as('memberA')
    await expect(m.update('qr', 'tok-a', { ownerPhone: '555-0100' })).rejects.toMatchObject(denied)
    await expect(m.set('permitQr', 'ptok-new', { permitId: 'p2', participants: ['A Name'] })).rejects.toMatchObject(denied)
    await expect(
      m.update('procedureQr', 'proc-a', { points: [{ key: 'P1', lockedBy: 'A Name' }] })
    ).rejects.toMatchObject(denied)
    expect(await adminEngine.get(null, 'qr', 'tok-a')).not.toHaveProperty('ownerPhone')
  })

  it('accepts what the builders write, and lets an old mirror be corrected', async () => {
    const m = as('memberA')
    await m.update('qr', 'tok-a', { status: 'to_be_refilled', centerName: 'Depot' })
    await m.update('procedureQr', 'proc-a', { points: [{ key: 'P1', locked: true }], pointCount: 1 })
    // A key already on the document does not block a fix to the others.
    await m.update('qr', 'tok-legacy', { status: 'active' })
  })
})

// Writes every employee makes on rows somebody else created: the record-number
// counters, LOTO lock state, and completing an assigned inspection.
describe('employee: shared work rows', () => {
  beforeAll(async () => {
    await seed('docSeq', 'incident', { n: 7 })
    await seed('procedures', 'pr1', { title: 'Pump', status: 'approved', createdBy: 'adminA', isolationPoints: [] })
    await seed('inspectionTemplates', 'it1', {
      title: 'Monthly',
      createdBy: 'adminA',
      assignments: [{ id: 'as1', assignee: 'Mo', status: 'Pending' }],
    })
  })
  const denied = { code: 'permission-denied' }

  it('draws the next record number, but never moves a counter back', async () => {
    const m = as('memberA')
    await m.set('docSeq', 'incident', { n: 8 })
    await expect(m.set('docSeq', 'incident', { n: 3 })).rejects.toMatchObject(denied)
  })

  it('applies a lock to a procedure, but cannot approve or reject one', async () => {
    const m = as('memberA')
    await m.update('procedures', 'pr1', { lockSummary: { status: 'locked', lockedCount: 1 } })
    await expect(m.update('procedures', 'pr1', { status: 'rejected' })).rejects.toMatchObject(denied)
  })

  it('completes an assigned inspection without being able to change the assignment', async () => {
    const m = as('memberA')
    const assignments = (await adminEngine.get(null, 'inspectionTemplates', 'it1')).assignments
    await m.update('inspectionTemplates', 'it1', {
      assignments: [{ ...assignments[0], status: 'Completed' }],
      updatedAt: '2026-11-10',
    })
    await expect(
      m.update('inspectionTemplates', 'it1', { assignments: [{ ...assignments[0], assignee: 'Someone else' }] })
    ).rejects.toMatchObject(denied)
    await expect(m.update('inspectionTemplates', 'it1', { title: 'Renamed', updatedAt: 'x' })).rejects.toMatchObject(denied)
  })
})

// LOTO isolation permits: the lifecycle, and who may move each step.
describe('LOTO permits', () => {
  const ts = (ms) => ({ __ohsms: 'ts', s: Math.floor(ms / 1000), ns: 0 })
  const H = 3600 * 1000
  const base = { requestedBy: 'memberA', personnelUids: ['memberA', 'crewB'], windowEnd: ts(Date.parse('2026-11-11T18:00:00Z')) }
  beforeAll(async () => {
    await seed('users', 'crewB', { role: 'member', status: 'approved' })
    for (const [id, status] of [
      ['lp-req', 'requested'], ['lp-req2', 'requested'], ['lp-req3', 'requested'], ['lp-req4', 'requested'],
      ['lp-app', 'approved'], ['lp-act', 'active'], ['lp-act2', 'active'], ['lp-ret', 'returned'],
    ]) {
      await seed('lotoPermits', id, { ...base, status })
    }
  })
  const denied = { code: 'permission-denied' }

  // A general shift that started ten minutes ago: an open window.
  const open = () => {
    const start = Date.now() - 10 * 60 * 1000
    return { shift: 'general', siteId: 's-1', windowStart: ts(start), windowEnd: ts(start + 9 * H) }
  }

  it('lets an employee raise a permit only as requested', async () => {
    const m = as('memberA')
    await m.set('lotoPermits', 'lp-new', { ...base, ...open(), status: 'requested' })
    await expect(m.set('lotoPermits', 'lp-skip', { ...base, ...open(), status: 'active' })).rejects.toMatchObject(denied)
  })

  it('takes the window from the shift, not from whatever was typed', async () => {
    const m = as('memberA')
    const start = Date.now() - 10 * 60 * 1000
    // A 30-hour "shift", one that ended yesterday, one that starts tomorrow.
    await expect(m.set('lotoPermits', 'lp-w1', { ...base, ...open(), windowEnd: ts(start + 30 * H), status: 'requested' })).rejects.toMatchObject(denied)
    await expect(m.set('lotoPermits', 'lp-w2', { ...base, shift: 'A', windowStart: ts(start - 32 * H), windowEnd: ts(start - 24 * H), status: 'requested' })).rejects.toMatchObject(denied)
    await expect(m.set('lotoPermits', 'lp-w3', { ...base, shift: 'A', windowStart: ts(start + 24 * H), windowEnd: ts(start + 32 * H), status: 'requested' })).rejects.toMatchObject(denied)
  })

  it('uses a site\'s saved shift clocks once an Admin has set them, and only an Admin may', async () => {
    const shifts = { sites: { 's-9': { zoneOffsetMinutes: 0, shifts: { day: { start: '00:00', end: '23:59' } } } } }
    await expect(as('memberA').set('lotoSettings', 'shifts', shifts)).rejects.toMatchObject(denied)
    await as('adminA').set('lotoSettings', 'shifts', shifts)
    const d = new Date()
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0)
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59)
    const m = as('memberA')
    await m.set('lotoPermits', 'lp-cfg', { ...base, siteId: 's-9', shift: 'day', windowStart: ts(start), windowEnd: ts(end), status: 'requested' })
    await expect(
      m.set('lotoPermits', 'lp-cfg2', { ...base, siteId: 's-9', shift: 'day', windowStart: ts(start), windowEnd: ts(end - 60000), status: 'requested' })
    ).rejects.toMatchObject(denied)
  })

  it('refuses a permit too large to read or print', async () => {
    const m = as('memberA')
    await expect(m.set('lotoPermits', 'lp-big', { ...base, ...open(), status: 'requested', jobDescription: 'x'.repeat(2001) })).rejects.toMatchObject(denied)
    await expect(
      m.set('lotoPermits', 'lp-many', { ...base, ...open(), status: 'requested', vendorWorkers: Array.from({ length: 101 }, (_, i) => ({ name: `W${i}` })) })
    ).rejects.toMatchObject(denied)
  })

  it('refuses an employee approving, even their own permit', async () => {
    await expect(
      as('memberA').update('lotoPermits', 'lp-req', { status: 'approved', approval: { by: 'memberA', selfApproved: true, selfApprovalReason: 'night shift' } })
    ).rejects.toMatchObject(denied)
    await expect(
      as('crewB').update('lotoPermits', 'lp-req', { status: 'approved', approval: { by: 'crewB' } })
    ).rejects.toMatchObject(denied)
  })

  it('lets an Admin approve, but not in someone else\'s name or for a permit they are named on', async () => {
    const admin = as('adminA')
    await expect(admin.update('lotoPermits', 'lp-req', { status: 'approved', approval: { by: 'memberA' } })).rejects.toMatchObject(denied)
    await admin.update('lotoPermits', 'lp-req', { status: 'approved', approval: { by: 'adminA' } })
    await seed('lotoPermits', 'lp-adminnamed', { ...base, personnelUids: ['adminA'], status: 'requested' })
    await expect(
      admin.update('lotoPermits', 'lp-adminnamed', { status: 'approved', approval: { by: 'adminA' } })
    ).rejects.toMatchObject(denied)
    // The requester may approve only by recording why nobody else could.
    await seed('lotoPermits', 'lp-adminown', { ...base, requestedBy: 'adminA', status: 'requested' })
    await expect(
      admin.update('lotoPermits', 'lp-adminown', { status: 'approved', approval: { by: 'adminA' } })
    ).rejects.toMatchObject(denied)
    await admin.update('lotoPermits', 'lp-adminown', {
      status: 'approved',
      approval: { by: 'adminA', selfApproved: true, selfApprovalReason: 'only approver on site tonight' },
    })
  })

  it('holds every permit to the order of steps', async () => {
    const m = as('memberA')
    await expect(m.update('lotoPermits', 'lp-req2', { status: 'active' })).rejects.toMatchObject(denied)
    await expect(m.update('lotoPermits', 'lp-ret', { status: 'active' })).rejects.toMatchObject(denied)
    await expect(as('adminA').update('lotoPermits', 'lp-ret', { status: 'active' })).rejects.toMatchObject(denied)
    await m.update('lotoPermits', 'lp-app', { status: 'active' })
    await m.update('lotoPermits', 'lp-act', { status: 'returned' })
  })

  it('keeps emergency removal, extensions and other people\'s withdrawals for an Admin', async () => {
    await expect(as('memberA').update('lotoPermits', 'lp-act2', { status: 'emergency_removed' })).rejects.toMatchObject(denied)
    await expect(as('crewB').update('lotoPermits', 'lp-req3', { status: 'withdrawn' })).rejects.toMatchObject(denied)
    await as('memberA').update('lotoPermits', 'lp-req3', { status: 'withdrawn' })
    const end = Date.parse('2026-11-11T18:00:00Z')
    await expect(as('memberA').update('lotoPermits', 'lp-act2', { windowEnd: ts(end + H) })).rejects.toMatchObject(denied)
    await expect(as('adminA').update('lotoPermits', 'lp-act2', { windowEnd: ts(end + 30 * H) })).rejects.toMatchObject(denied)
    await as('adminA').update('lotoPermits', 'lp-act2', { windowEnd: ts(end + 4 * H) })
    await as('adminA').update('lotoPermits', 'lp-act2', { status: 'emergency_removed' })
  })

  it('does not let a stranger start or return a permit they are not on', async () => {
    await seed('users', 'strangerC', { role: 'member', status: 'approved' })
    await seed('lotoPermits', 'lp-app2', { ...base, status: 'approved' })
    await expect(as('strangerC').update('lotoPermits', 'lp-app2', { status: 'active' })).rejects.toMatchObject(denied)
  })
})

// S-14: a scanned token lets a stranger file one bounded report, nothing more.
describe('anonymous QR reports are bounded', () => {
  beforeAll(async () => {
    await seed('qr', 'tok-anon', { extId: 'x9', token: 'tok-anon' })
  })
  const report = (extra = {}) => ({
    source: 'qr', approvalStatus: 'pending', reportedBy: 'public', kind: 'defect',
    extId: 'x9', token: 'tok-anon', note: 'Pin missing', ...extra,
  })
  const anon = as('')

  it('accepts a report a QR form would send', async () => {
    await anon.set('reports', 'anon-ok', report())
  })

  it('refuses an oversized note or name, and fields the form never sends', async () => {
    await expect(anon.set('reports', 'anon-big', report({ note: 'x'.repeat(501) }))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(anon.set('reports', 'anon-name', report({ reportedByName: 'y'.repeat(121) }))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(anon.set('reports', 'anon-extra', report({ payload: 'anything' }))).rejects.toMatchObject({ code: 'permission-denied' })
    await expect(anon.set('reports', 'anon-obj', report({ note: { nested: 'x' } }))).rejects.toMatchObject({ code: 'permission-denied' })
  })
})

// Site scope: a record that names a site is for the people who reach that
// site. Reach is the posting, granted sites, and every site of a granted
// region or entity; an admin reaches all.
describe('site scope', () => {
  beforeAll(async () => {
    for (const [id, region, entity] of [
      ['n1', 'North', 'E1'], ['n2', 'North', 'E2'], ['s1', 'South', 'E1'], ['e1', 'East', 'E3'],
    ]) {
      await seed('sites', id, { name: id, region, entity })
    }
    await seed('users', 'northMgr', { role: 'manager', status: 'approved', access: { regions: ['North'] } })
    await seed('users', 'e1Emp', { role: 'member', status: 'approved', access: { entities: ['E1'] } })
    await seed('users', 'nobodyEmp', { role: 'member', status: 'approved', access: {} })
    for (const site of ['n1', 'n2', 's1', 'e1']) {
      await seed('incidents', `inc-${site}`, { title: `At ${site}`, siteId: site })
    }
    await seed('incidents', 'inc-unsited', { title: 'Older, named by text', location: 'n1' })
    await seed('incidents/inc-e1/photos', 'p1', { url: 'x' })
    await seed('documents', 'doc-e1-site', { title: 'Local', siteId: 'e1', visibility: 'site' })
    await seed('documents', 'doc-e1-all', { title: 'Shared', siteId: 'e1', visibility: 'all' })
  })
  const denied = { code: 'permission-denied' }
  const ids = async (uid, path) => (await as(uid).list(path)).map((d) => d.id).sort()

  it('shows each person only the sites they reach, plus records that name no site', async () => {
    expect(await ids('northMgr', 'incidents')).toEqual(
      expect.arrayContaining(['inc-n1', 'inc-n2', 'inc-unsited'])
    )
    expect(await ids('northMgr', 'incidents')).not.toContain('inc-s1')
    expect(await ids('e1Emp', 'incidents')).toEqual(expect.arrayContaining(['inc-n1', 'inc-s1']))
    expect(await ids('e1Emp', 'incidents')).not.toContain('inc-n2')
    const none = await ids('nobodyEmp', 'incidents')
    expect(none).toContain('inc-unsited')
    expect(none.filter((id) => ['inc-n1', 'inc-n2', 'inc-s1', 'inc-e1'].includes(id))).toEqual([])
    expect((await ids('adminA', 'incidents')).length).toBeGreaterThanOrEqual(5)
  })

  it('refuses a get, and everything inside the record, outside the reach', async () => {
    expect(await as('northMgr').get('incidents', 'inc-e1')).toBeNull()
    expect(await as('northMgr').list('incidents/inc-e1/photos')).toEqual([])
    expect(await as('northMgr').get('incidents/inc-e1/photos', 'p1')).toBeNull()
    await expect(as('northMgr').set('incidents/inc-e1/photos', 'p2', { url: 'y' })).rejects.toMatchObject(denied)
    expect(await as('adminA').get('incidents/inc-e1/photos', 'p1')).toMatchObject({ url: 'x' })
  })

  it('refuses writing a record into a site outside the reach, or moving one there', async () => {
    const mgr = as('northMgr')
    await mgr.set('incidents', 'inc-new-n1', { title: 'New', siteId: 'n1' })
    await expect(mgr.set('incidents', 'inc-new-e1', { title: 'New', siteId: 'e1' })).rejects.toMatchObject(denied)
    await expect(mgr.update('incidents', 'inc-n1', { siteId: 'e1' })).rejects.toMatchObject(denied)
    await expect(mgr.update('incidents', 'inc-e1', { title: 'Edited' })).rejects.toThrow()
    expect((await adminEngine.get(null, 'incidents', 'inc-e1')).title).toBe('At e1')
  })

  it('keeps a document marked for everyone visible to everyone', async () => {
    expect(await ids('northMgr', 'documents')).toContain('doc-e1-all')
    expect(await ids('northMgr', 'documents')).not.toContain('doc-e1-site')
  })

  it('does not filter the people directory or the site register', async () => {
    expect((await as('nobodyEmp').list('sites')).length).toBeGreaterThanOrEqual(4)
    expect((await as('nobodyEmp').list('users')).length).toBeGreaterThan(3)
  })
})

// The people directory: colleagues' names and roles for everyone; the rest of
// a profile only for its owner and admins.
describe('the people directory', () => {
  beforeAll(async () => {
    await seed('users', 'dirTarget', {
      name: 'Tara',
      email: 'tara@example.test',
      role: 'member',
      status: 'approved',
      department: 'Safety',
      siteId: 's-1',
      access: { sites: ['s-1', 's-2'] },
      accessRequest: { sites: ['s-9'] },
      mustChangePassword: false,
      portalWidgets: ['a'],
    })
  })
  const PRIVATE = ['accessRequest', 'mustChangePassword', 'portalWidgets']

  it('shows an employee only the directory fields of a colleague, in a get and a list', async () => {
    const got = await as('memberA').get('users', 'dirTarget')
    expect(got).toMatchObject({ name: 'Tara', email: 'tara@example.test', role: 'member', department: 'Safety', siteId: 's-1' })
    for (const k of [...PRIVATE, 'access']) expect(got, k).not.toHaveProperty(k)
    const listed = (await as('memberA').list('users')).find((u) => u.id === 'dirTarget')
    for (const k of [...PRIVATE, 'access']) expect(listed, k).not.toHaveProperty(k)
    expect(await as('auditorA').get('users', 'dirTarget')).not.toHaveProperty('access')
  })

  it('adds site access for a manager, and everything for an admin and for the person themself', async () => {
    const mgr = await as('managerA').get('users', 'dirTarget')
    expect(mgr.access).toEqual({ sites: ['s-1', 's-2'] })
    for (const k of PRIVATE) expect(mgr, k).not.toHaveProperty(k)
    expect(await as('adminA').get('users', 'dirTarget')).toHaveProperty('accessRequest')
    expect(await as('memberA').get('users', 'memberA')).toHaveProperty('access')
  })
})

describe('LOTO log and padlock claims', () => {
  beforeAll(async () => {
    await seed('lockClaims', 'L-12', { lockNo: 'L-12', procedureId: 'pr-a', equipment: 'Pump A' })
    await seed('lotoEvents', 'ev1', { action: 'lock', by: 'memberA' })
    await seed('lotoPermits', 'lp-log', { status: 'active', requestedBy: 'memberA' })
    await seed('lotoPermits/lp-log/events', 'pe1', { type: 'started', by: 'memberA' })
  })
  const denied = { code: 'permission-denied' }

  it('keeps the activity log and permit timelines append-only, in the writer\'s own name', async () => {
    const m = as('memberA')
    await m.set('lotoEvents', 'ev2', { action: 'unlock', by: 'memberA' })
    await expect(m.set('lotoEvents', 'ev3', { action: 'unlock', by: 'adminA' })).rejects.toMatchObject(denied)
    await expect(m.update('lotoEvents', 'ev1', { action: 'nothing' })).rejects.toMatchObject(denied)
    await expect(as('adminA').remove('lotoEvents', 'ev1')).rejects.toMatchObject(denied)
    await expect(m.update('lotoPermits/lp-log/events', 'pe1', { type: 'returned' })).rejects.toMatchObject(denied)
    await m.set('lotoPermits/lp-log/events', 'pe2', { type: 'note', by: 'memberA' })
  })

  it('will not move a held padlock to another machine, and lets anyone release it', async () => {
    const m = as('memberA')
    await expect(m.set('lockClaims', 'L-12', { lockNo: 'L-12', procedureId: 'pr-b', equipment: 'Pump B' })).rejects.toMatchObject(denied)
    await m.set('lockClaims', 'L-12', { lockNo: 'L-12', procedureId: 'pr-a', equipment: 'Pump A (dept lock)' })
    await m.remove('lockClaims', 'L-12')
    await m.set('lockClaims', 'L-12', { lockNo: 'L-12', procedureId: 'pr-b', equipment: 'Pump B' })
  })
})

// Assigned work: the auditee answers their findings; a member of an
// incident's investigation team adds to the investigation. Judged on the
// stored record's uids, never a name and never the values being written.
describe('employee: assigned work', () => {
  beforeAll(async () => {
    await seed('auditFindings', 'af1', {
      createdByUid: 'adminA', auditor: 'Ada', auditeeUid: 'memberA', status: 'Reported',
      taskDetails: { auditee: 'Mo' }, findings: [{ id: 'f1', text: 'No guard', response: '' }],
    })
    await seed('auditFindings', 'af2', { createdByUid: 'adminA', taskDetails: { auditee: 'Mo' }, findings: [] })
    await seed('incidents', 'inv1', {
      title: 'Fall', createdBy: 'adminA', lifecycle: 'investigation',
      team: [{ kind: 'internal', uid: 'memberA', name: 'Mo' }, { kind: 'external', name: 'Contractor' }],
      investigations: [],
    })
  })
  const denied = { code: 'permission-denied' }

  it('lets the assigned auditee answer, and nothing more', async () => {
    const m = as('memberA')
    await m.update('auditFindings', 'af1', {
      findings: [{ id: 'f1', text: 'No guard', response: 'Guard fitted' }], status: 'Submitted for Verification', submissionDate: '2026-11-10',
    })
    await expect(m.update('auditFindings', 'af1', { auditeeUid: 'crewB' })).rejects.toMatchObject(denied)
    await expect(m.update('auditFindings', 'af1', { taskDetails: { auditee: 'Someone' } })).rejects.toMatchObject(denied)
    // Named as auditee by text only: not assigned by uid, so not editable.
    await expect(m.update('auditFindings', 'af2', { status: 'Submitted' })).rejects.toMatchObject(denied)
  })

  it('cannot assign itself by writing its own uid in', async () => {
    await expect(as('crewB').update('auditFindings', 'af2', { auditeeUid: 'crewB', status: 'Submitted' })).rejects.toMatchObject(denied)
    await expect(
      as('crewB').update('incidents', 'inv1', { team: [{ kind: 'internal', uid: 'crewB' }], investigations: [{ method: '5why' }] })
    ).rejects.toMatchObject(denied)
  })

  it('lets an investigation team member add to the investigation, but not change the team or verify', async () => {
    const m = as('memberA')
    await m.update('incidents', 'inv1', { investigations: [{ method: '5why', whys: ['Wet floor'] }], chronology: [{ at: '09:00', what: 'Slip' }] })
    await expect(m.update('incidents', 'inv1', { team: [] })).rejects.toMatchObject(denied)
    await expect(m.update('incidents', 'inv1', { lifecycle: 'verified' })).rejects.toMatchObject(denied)
    expect((await adminEngine.get(null, 'incidents', 'inv1')).investigations).toHaveLength(1)
  })
})

describe('two-step login flags', () => {
  beforeAll(async () => {
    await seed('users', 'mfaGated', {
      role: 'manager',
      status: 'approved',
      name: 'Gate',
      mfaRequired: true,
    })
    await seed('users', 'mfaOn', { role: 'member', status: 'approved', name: 'On', mfaEnabled: true })
  })

  it('holds an account that must set up two-step login to its own profile', async () => {
    const gated = as('mfaGated')
    expect(await gated.get('users', 'mfaGated')).toMatchObject({ mfaRequired: true })
    expect(await gated.get('incidents', 'i1')).toBeNull()
    expect(await gated.get('users', 'adminA')).toBeNull()
    await expect(gated.set('incidents', 'mfa-sneak', { title: 'no' })).rejects.toMatchObject({
      code: 'permission-denied',
    })
  })

  it('refuses a client that marks itself enrolled to clear the gate', async () => {
    await expect(as('mfaGated').update('users', 'mfaGated', { mfaEnabled: true })).rejects.toThrow()
    // Not even an admin: only the server, which holds the secret, sets it.
    await expect(as('adminA').update('users', 'mfaGated', { mfaEnabled: true })).rejects.toThrow()
    expect((await adminEngine.get(null, 'users', 'mfaGated')).mfaEnabled).toBeUndefined()
  })

  it('refuses a person switching the flag off on their own profile', async () => {
    await expect(as('mfaOn').update('users', 'mfaOn', { mfaEnabled: false })).rejects.toThrow()
    expect((await adminEngine.get(null, 'users', 'mfaOn')).mfaEnabled).toBe(true)
  })

  it('leaves requiring it to an admin', async () => {
    await expect(as('memberA').update('users', 'memberA', { mfaRequired: true })).rejects.toThrow()
    await expect(as('managerA').update('users', 'memberA', { mfaRequired: true })).rejects.toThrow()
    await as('adminA').update('users', 'mfaOn', { mfaRequired: true })
    expect((await adminEngine.get(null, 'users', 'mfaOn')).mfaRequired).toBe(true)
    // ...and lifting it is the same privilege.
    await expect(as('mfaOn').update('users', 'mfaOn', { mfaRequired: false })).rejects.toThrow()
  })

  it('refuses an admin creating an account already marked enrolled', async () => {
    await expect(
      as('adminA').set('users', 'mfaFake', {
        role: 'member',
        status: 'approved',
        mustChangePassword: true,
        mfaEnabled: true,
      })
    ).rejects.toThrow()
  })
})

describe('the sign-in address', () => {
  beforeAll(async () => {
    await seed('users', 'emailOwner', { role: 'member', status: 'approved', name: 'Em', email: 'em@example.test' })
  })

  it("refuses a member taking a colleague's address, or changing their own", async () => {
    await expect(
      as('memberA').update('users', 'memberA', { email: 'ada@example.test' })
    ).rejects.toThrow()
    await expect(
      as('emailOwner').update('users', 'emailOwner', { email: 'EM@example.test ' })
    ).rejects.toThrow()
    await expect(as('managerA').update('users', 'emailOwner', { email: 'mia@example.test' })).rejects.toThrow()
    expect((await adminEngine.get(null, 'users', 'emailOwner')).email).toBe('em@example.test')
  })

  it('leaves correcting an address to an admin', async () => {
    await as('adminA').update('users', 'emailOwner', { email: 'emma@example.test' })
    expect((await adminEngine.get(null, 'users', 'emailOwner')).email).toBe('emma@example.test')
  })
})

describe('audit entries say who and when, as the server knows it', () => {
  const entry = (extra = {}) => ({
    actorUid: 'memberA',
    actorName: 'Ada (Administrator)',
    action: 'record.update',
    module: 'ptw',
    target: 'permit',
    summary: 'x',
    at: { __ohsms: 'ts', s: 1, ns: 0 },
    ...extra,
  })

  it("stamps the writer's stored name and the server's time over what was sent", async () => {
    const before = Date.now()
    await as('memberA').set('auditLogs', 'forged1', entry())
    const got = await adminEngine.get(null, 'auditLogs', 'forged1')
    expect(got.actorName).toBe('Mo')
    expect(got.at.toMillis()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('refuses prose in the fields the log shows as labels', async () => {
    for (const extra of [
      { action: 'Permit approved by Ada' },
      { module: 'ptw <b>' },
      { target: ' ' },
      { action: '' },
    ]) {
      await expect(as('memberA').set('auditLogs', `bad-${Math.random()}`, entry(extra))).rejects.toThrow()
    }
  })

  it('still refuses an entry in someone else’s name', async () => {
    await expect(as('memberA').set('auditLogs', 'forged2', entry({ actorUid: 'adminA' }))).rejects.toThrow()
  })

  it('refuses a self-rename, and leaves renaming to an admin', async () => {
    await expect(as('memberA').update('users', 'memberA', { name: 'Mo (Administrator)' })).rejects.toThrow()
    await expect(as('managerA').update('users', 'memberA', { name: 'Mo M' })).rejects.toThrow()
    await as('adminA').update('users', 'auditorA', { name: 'Audrey' })
    expect((await adminEngine.get(null, 'users', 'auditorA')).name).toBe('Audrey')
  })
})

describe('work permits after a decision, and their public QR record', () => {
  const window = { validFrom: '2026-11-10T06:00:00.000Z', validTo: '2026-11-10T14:00:00.000Z' }
  const decision = (status) => ({ status, by: 'managerA', byName: 'Mia', at: '2026-11-10T06:10:00.000Z', note: '' })
  const permit = (id, extra = {}) => ({
    permitNo: `PTW-2026-${id}`,
    docId: `D-${id}`,
    qrToken: `tok-${id}`,
    site: 'Depot',
    typeOfWork: 'hot_work',
    jobLocation: 'Bay 2',
    jobDescription: 'Weld rail',
    issuedToName: 'Raj',
    hazards: ['fire'],
    ppe: ['gloves'],
    participants: [{ name: 'A' }, { name: 'B' }],
    engineering: { status: 'pending' },
    operations: { status: 'pending' },
    closure: null,
    extension: null,
    storedStatus: 'draft',
    createdBy: 'memberA',
    ...window,
    ...extra,
  })
  // What ptw/lib/data.js writes: mirrorDisplayFields + mirrorStatusFields.
  const statusOf = (p) => ({
    storedStatus: p.storedStatus,
    engineering: { status: p.engineering?.status || 'pending' },
    operations: { status: p.operations?.status || 'pending' },
    closure: p.closure
      ? { engineering: { status: p.closure.engineering?.status || 'pending' }, operations: { status: p.closure.operations?.status || 'pending' } }
      : null,
    extension: p.extension
      ? { engineering: { status: p.extension.engineering?.status || 'pending' }, operations: { status: p.extension.operations?.status || 'pending' }, newValidTo: p.extension.newValidTo || null }
      : null,
    closedDueToObservation: p.closedDueToObservation || null,
    validFrom: p.validFrom || null,
    validTo: p.validTo || null,
  })
  const mirrorOf = (id, p) => ({
    orgName: 'Keel Works',
    permitId: id,
    token: p.qrToken,
    permitNo: p.permitNo,
    docId: p.docId,
    site: p.site,
    ...mirrorDisplayFields(p, Date.parse('2026-11-10T07:00:00.000Z')),
    ...statusOf(p),
  })
  const approved = { engineering: decision('approved'), operations: decision('approved') }

  beforeAll(async () => {
    await seed('permits', 'pOpen', permit('1'))
    await seed('permits', 'pApproved', permit('2', approved))
    await seed('permitQr', 'tok-2', mirrorOf('pApproved', permit('2', approved)))
    await seed('permits', 'pExtended', permit('3', {
      ...approved,
      extension: { newValidTo: '2026-11-10T18:00:00.000Z', engineering: decision('approved'), operations: decision('approved') },
      validTo: '2026-11-10T18:00:00.000Z',
    }))
  })

  it('refuses an employee moving the dates or rewriting the content of an approved permit', async () => {
    for (const data of [
      { validTo: '2099-01-01T00:00:00.000Z' },
      { validFrom: '2026-11-11T06:00:00.000Z' },
      { hazards: [] },
      { jobDescription: 'Something else' },
    ]) {
      await expect(as('memberA').update('permits', 'pApproved', data), JSON.stringify(data)).rejects.toThrow()
    }
    expect((await adminEngine.get(null, 'permits', 'pApproved')).validTo).toBe(window.validTo)
  })

  it('refuses an employee moving the end date of an approved extension', async () => {
    await expect(
      as('memberA').update('permits', 'pExtended', { 'extension.newValidTo': '2099-01-01T00:00:00.000Z' })
    ).rejects.toThrow()
  })

  it('still lets an employee carry the permit along: closure, extension, an unsafe stop', async () => {
    const pending = { engineering: { status: 'pending' }, operations: { status: 'pending' } }
    await as('memberA').update('permits', 'pApproved', { closure: { requestedBy: 'memberA', ...pending } })
    await as('memberA').update('permits', 'pApproved', {
      extension: { requestedBy: 'memberA', newValidTo: '2026-11-10T20:00:00.000Z', ...pending },
    })
    await as('memberA').update('permits', 'pApproved', {
      closedDueToObservation: { observationId: 'o1', by: 'memberA' },
      storedStatus: 'closed_noncompliance',
    })
    // ...and an unapproved draft stays theirs to edit.
    await as('memberA').update('permits', 'pOpen', { hazards: ['fire', 'fumes'] })
  })

  it('leaves a decided permit’s dates to a manager', async () => {
    await as('managerA').update('permits', 'pExtended', { validTo: '2026-11-10T19:00:00.000Z' })
  })

  it('accepts the QR record the app writes, from an employee', async () => {
    await as('memberA').set('permitQr', 'tok-1', mirrorOf('pOpen', await adminEngine.get(null, 'permits', 'pOpen')))
    const now = await adminEngine.get(null, 'permits', 'pApproved')
    const { orgName: _o, permitId: _p, token: _t, ...merge } = mirrorOf('pApproved', now)
    await as('memberA').set('permitQr', 'tok-2', merge, { merge: true })
  })

  it('refuses a QR record that disagrees with its permit, from anyone', async () => {
    const real = mirrorOf('pOpen', await adminEngine.get(null, 'permits', 'pOpen'))
    for (const fake of [
      { engineering: { status: 'approved' }, operations: { status: 'approved' }, storedStatus: 'approved' },
      { validTo: '2099-01-01T00:00:00.000Z' },
      { hazards: ['none'] },
      { issuedToName: 'Someone else' },
    ]) {
      for (const uid of ['memberA', 'managerA']) {
        await expect(
          as(uid).set('permitQr', 'tok-1', { ...real, ...fake }),
          `${uid} ${JSON.stringify(fake)}`
        ).rejects.toThrow()
      }
    }
    // Blanking the detail once the job is over is the app's own move.
    await as('memberA').set('permitQr', 'tok-1', { ...real, hazards: [], jobDescription: '', withdrawn: true })
  })

  it('refuses a QR record for no permit, or under another permit’s token', async () => {
    const real = mirrorOf('pOpen', await adminEngine.get(null, 'permits', 'pOpen'))
    await expect(as('memberA').set('permitQr', 'tok-x', { ...real, token: 'tok-x' })).rejects.toThrow()
    await expect(
      as('memberA').set('permitQr', 'tok-ghost', { ...real, permitId: 'nope', token: 'tok-ghost' })
    ).rejects.toThrow()
  })
})

describe('the people directory cannot be searched by what it hides', () => {
  beforeAll(async () => {
    await seed('users', 'noMfa', { role: 'member', status: 'approved', name: 'Nia', mfaEnabled: false, mustChangePassword: true })
  })

  it('refuses an employee or a manager filtering or sorting people by a hidden field', async () => {
    for (const uid of ['memberA', 'managerA', 'auditorA']) {
      for (const opts of [
        { where: [{ field: 'mfaEnabled', op: '==', value: false }] },
        { where: [{ field: 'mustChangePassword', op: '==', value: true }] },
        { where: [{ field: 'accessRequest.sites', op: '!=', value: null }] },
        { orderBy: ['mfaRequired', 'desc'] },
      ]) {
        await expect(as(uid).list('users', opts), `${uid} ${JSON.stringify(opts)}`).rejects.toThrow()
        await expect(as(uid).count('users', opts), `${uid} count`).rejects.toThrow()
      }
    }
    // A manager may search by access, which a manager is shown; an employee may not.
    const byAccess = { where: [{ field: 'access.sites', op: '!=', value: null }] }
    await as('managerA').list('users', byAccess)
    await expect(as('memberA').list('users', byAccess)).rejects.toThrow()
  })

  it('still lets anyone search by what the directory shows, and an admin by anything', async () => {
    const byName = { where: [{ field: 'name', op: '==', value: 'Nia' }], orderBy: ['name', 'asc'] }
    expect((await as('memberA').list('users', byName)).map((u) => u.id)).toEqual(['noMfa'])
    const flagged = await as('adminA').list('users', { where: [{ field: 'mfaEnabled', op: '==', value: false }] })
    expect(flagged.map((u) => u.id)).toContain('noMfa')
  })
})

describe('certifying yourself', () => {
  const todayIso = () => new Date().toISOString().slice(0, 10)
  beforeAll(async () => {
    await seed('technicians', 'techReal', {
      name: 'Ravi',
      lockNo: 'P-1',
      licenceNo: 'WL-1',
      licenceExp: '2025-01-01',
      active: true,
      createdBy: 'managerA',
    })
    await seed('trainingCourses', 'confined', { name: 'Confined space', validityMonths: 12 })
    await seed('trainingCourses', 'induction', { name: 'Induction', validityMonths: 0 })
  })

  it('leaves the technician register to managers', async () => {
    await expect(
      as('memberA').set('technicians', 'techSelf', {
        name: 'Mo',
        lockNo: 'P-9',
        licenceNo: 'MADE-UP',
        licenceExp: '2099-01-01',
        active: true,
        createdBy: 'memberA',
      })
    ).rejects.toThrow()
    await expect(as('memberA').update('technicians', 'techReal', { active: false })).rejects.toThrow()
    await expect(as('memberA').remove('technicians', 'techReal')).rejects.toThrow()
    await as('managerA').update('technicians', 'techReal', { licenceExp: '2027-01-01' })
    await as('managerA').set('technicians', 'techNew', { name: 'Ana', lockNo: 'P-2', licenceNo: 'WL-2', active: true, createdBy: 'managerA' })
  })

  // What My Learning writes (training/lib/data.js selfCompleteTraining).
  const selfRecord = (extra = {}) => {
    const completedOn = todayIso()
    const [y, m, d] = completedOn.split('-').map(Number)
    const exp = new Date(Date.UTC(y, m - 1 + 12, d))
    if (exp.getUTCDate() !== d) exp.setUTCDate(0)
    return {
      courseId: 'confined',
      courseName: 'Confined space',
      category: 'Other',
      validityMonths: 12,
      employeeUid: 'memberA',
      employeeName: 'Mo',
      trainerName: '',
      completedOn,
      expiresOn: exp.toISOString().slice(0, 10),
      loggedBy: 'self',
      createdBy: 'memberA',
      ...extra,
    }
  }

  it('accepts the self-completion the app writes', async () => {
    await as('memberA').set('trainingRecords', 'selfOk', selfRecord())
    await as('memberA').set(
      'trainingRecords',
      'selfNoExpiry',
      selfRecord({ courseId: 'induction', courseName: 'Induction', validityMonths: 0, expiresOn: '' })
    )
  })

  it('refuses an employee certifying themselves any other way, or a colleague', async () => {
    for (const [label, data] of [
      ['trainer-led', selfRecord({ trainerName: 'Chief Trainer', loggedBy: undefined })],
      ['not flagged self', selfRecord({ loggedBy: undefined })],
      ['a colleague', selfRecord({ employeeUid: 'managerA', employeeName: 'Mia' })],
      ['valid until 2099', selfRecord({ expiresOn: '2099-01-01' })],
      ['a longer validity', selfRecord({ validityMonths: 120 })],
      ['backdated', selfRecord({ completedOn: '2024-01-01' })],
      ['a course that does not exist', selfRecord({ courseId: 'ghost' })],
    ]) {
      await expect(as('memberA').set('trainingRecords', `bad-${label}`, data), label).rejects.toThrow()
    }
  })

  it('refuses an employee changing or removing a record afterwards', async () => {
    await expect(as('memberA').update('trainingRecords', 'selfOk', { expiresOn: '2099-01-01' })).rejects.toThrow()
    await expect(as('memberA').remove('trainingRecords', 'selfOk')).rejects.toThrow()
  })

  it('leaves trainer-led records, for anyone, to managers', async () => {
    await as('managerA').set('trainingRecords', 'logged', {
      courseId: 'confined',
      employeeUid: 'memberA',
      trainerName: 'Chief Trainer',
      completedOn: '2026-01-05',
      expiresOn: '2027-01-05',
      createdBy: 'managerA',
    })
  })
})

describe('closing an incident or illness with open actions', () => {
  beforeAll(async () => {
    await seed('incidents', 'incOpenCapa', {
      lifecycle: 'capa',
      createdBy: 'memberA',
      capa: [{ id: 'a1', status: 'closed' }, { id: 'a2', status: 'in_progress' }],
    })
    await seed('illnesses', 'illOpen', { lifecycle: 'actions', createdBy: 'memberA', actions: [{ id: 'b1' }] })
  })

  it('refuses closing while any action is not closed, for anyone', async () => {
    for (const uid of ['memberA', 'managerA', 'adminA']) {
      await expect(as(uid).update('incidents', 'incOpenCapa', { lifecycle: 'closed' }), uid).rejects.toThrow()
      await expect(as(uid).update('illnesses', 'illOpen', { lifecycle: 'closed' }), uid).rejects.toThrow()
    }
  })

  it('allows it once every action is closed', async () => {
    await as('managerA').update('incidents', 'incOpenCapa', {
      capa: [{ id: 'a1', status: 'closed' }, { id: 'a2', status: 'closed' }],
    })
    await as('managerA').update('incidents', 'incOpenCapa', { lifecycle: 'closed' })
    expect((await adminEngine.get(null, 'incidents', 'incOpenCapa')).lifecycle).toBe('closed')
  })
})

describe('an audit finding moves through its lifecycle only by the right hands', () => {
  beforeAll(async () => {
    await seed('users', 'auditeeA', { role: 'member', status: 'approved', name: 'Aud Ee' })
    await seed('users', 'auditorM', { role: 'member', status: 'approved', name: 'Aud Or' })
  })
  const finding = (status) => ({ status, auditeeUid: 'auditeeA', createdByUid: 'auditorM', findings: [] })

  it('refuses an auditee closing or returning their own findings', async () => {
    await seed('auditFindings', 'afl1', finding('Reported'))
    await expect(as('auditeeA').update('auditFindings', 'afl1', { status: 'Closed' })).rejects.toThrow()
    await as('auditeeA').update('auditFindings', 'afl1', { status: 'Submitted for Verification' })
    await expect(as('auditeeA').update('auditFindings', 'afl1', { status: 'Closed' })).rejects.toThrow()
    await expect(as('auditeeA').update('auditFindings', 'afl1', { status: 'Reported' })).rejects.toThrow()
  })

  it('lets the auditor return a submitted answer, and verify one', async () => {
    await seed('auditFindings', 'afl2', finding('Submitted for Verification'))
    await as('auditorM').update('auditFindings', 'afl2', { status: 'Reported', returnNote: 'Add evidence' })
    await as('auditeeA').update('auditFindings', 'afl2', { status: 'Submitted for Verification' })
    await as('auditorM').update('auditFindings', 'afl2', { status: 'Closed' })
    expect((await adminEngine.get(null, 'auditFindings', 'afl2')).status).toBe('Closed')
  })

  it('refuses a stranger moving the status, and a manager verifying their own answer', async () => {
    await seed('auditFindings', 'afl3', finding('Submitted for Verification'))
    await expect(as('memberA').update('auditFindings', 'afl3', { status: 'Closed' })).rejects.toThrow()
    await seed('auditFindings', 'afl4', { ...finding('Submitted for Verification'), auditeeUid: 'managerA' })
    await expect(as('managerA').update('auditFindings', 'afl4', { status: 'Closed' })).rejects.toThrow()
    await as('managerA').update('auditFindings', 'afl3', { status: 'Closed' })
  })
})

describe('in-app notifications (inbox/<uid>/items)', () => {
  const mine = 'inbox/memberA/items'
  const theirs = 'inbox/managerA/items'
  const item = { kind: 'action', title: 'Corrective action assigned to you', link: '/incidents/i1', readAt: null }

  it('shows a person their own and nobody else’s, admin included', async () => {
    await seed(mine, 'n1', item)
    await seed(theirs, 'n2', item)
    expect(await as('memberA').get(mine, 'n1')).toMatchObject({ kind: 'action' })
    expect(await as('memberA').list(mine)).toHaveLength(1)
    for (const uid of ['memberA', 'adminA', 'auditorA', '']) {
      expect(await as(uid).get(theirs, 'n2'), uid).toBeNull()
      expect(await as(uid).list(theirs), uid).toEqual([])
    }
    // A temporary password reaches nothing but the profile, the bell included.
    await seed('inbox/flaggedA/items', 'n3', item)
    expect(await as('flaggedA').list('inbox/flaggedA/items')).toEqual([])
  })

  it('takes no item from a client, in anyone’s inbox, their own and an admin’s included', async () => {
    const forged = { ...item, title: 'Approve PTW-12 now', link: '/permits/p1' }
    for (const [uid, path] of [
      ['memberA', theirs],
      ['memberA', mine],
      ['adminA', theirs],
      ['adminA', 'inbox/adminA/items'],
    ]) {
      await expect(as(uid).set(path, `forged-${uid}`, forged), `${uid} ${path}`).rejects.toMatchObject({
        code: 'permission-denied',
      })
    }
  })

  it('lets the owner mark one read, and change nothing else', async () => {
    await seed(mine, 'n4', item)
    await as('memberA').update(mine, 'n4', { readAt: '2026-11-10T09:00:00Z' })
    expect((await adminEngine.get(null, mine, 'n4')).readAt).toBe('2026-11-10T09:00:00Z')
    await expect(as('memberA').update(mine, 'n4', { link: 'https://evil.example/' })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    await expect(as('memberA').update(mine, 'n4', { title: 'rewritten', readAt: null })).rejects.toMatchObject({
      code: 'permission-denied',
    })
    // Someone else's item is not there to them at all: refused as missing.
    await expect(as('adminA').update(mine, 'n4', { readAt: null })).rejects.toThrow()
    expect((await adminEngine.get(null, mine, 'n4')).readAt).toBe('2026-11-10T09:00:00Z')
  })

  it('lets an auditor, who writes nothing else, read and dismiss their own', async () => {
    const path = 'inbox/auditorA/items'
    await seed(path, 'n5', item)
    await as('auditorA').update(path, 'n5', { readAt: '2026-11-10T09:00:00Z' })
    await as('auditorA').remove(path, 'n5')
    expect(await adminEngine.get(null, path, 'n5')).toBeNull()
  })

  it('lets the owner dismiss their own, and no one else', async () => {
    await seed(mine, 'n6', item)
    await as('managerA').remove(mine, 'n6').catch(() => {})
    await as('adminA').remove(mine, 'n6').catch(() => {})
    expect(await adminEngine.get(null, mine, 'n6')).not.toBeNull()
    await as('memberA').remove(mine, 'n6')
    expect(await adminEngine.get(null, mine, 'n6')).toBeNull()
  })
})

// A rejected permit's opening or closure, answered by its raiser and sent
// back to the one person who rejected it (stack/policy.mjs
// permitDecisionProblem). Each case is the write a hostile client would try.
describe('a rejected permit, answered and sent back to the person who rejected it', () => {
  const AT = '2026-11-10T06:10:00.000Z'
  const rejected = (by, note = 'No gas test attached') => ({ status: 'rejected', by, byName: 'Mia', at: AT, note })
  const approvedBy = (by) => ({ status: 'approved', by, byName: 'x', at: AT, note: '' })
  const base = (extra = {}) => ({
    permitNo: 'PTW-2026-R',
    engineering: { status: 'pending' },
    operations: approvedBy('managerB'),
    closure: null,
    extension: null,
    storedStatus: 'draft',
    createdBy: 'memberA',
    ...extra,
  })
  // What ptw/lib/data.js answerRejection writes for that team.
  const answer = (rejection, { by = 'memberA', text = 'Gas test done, certificate attached', reapprover = rejection.by } = {}) => ({
    status: 'pending',
    by: null,
    byName: '',
    at: null,
    note: '',
    reapprover,
    reapproverName: rejection.byName,
    rejection: { by: rejection.by, byName: rejection.byName, at: rejection.at, note: rejection.note },
    response: { by, byName: 'Mo', at: '2026-11-10T07:00:00.000Z', text },
  })
  const denied = { code: 'permission-denied' }

  beforeAll(async () => {
    await seed('users', 'managerB', { role: 'manager', status: 'approved', name: 'Max' })
    await seed('users', 'memberB', { role: 'member', status: 'approved', name: 'Mel' })
  })

  it('records a decision only in the decider’s own name', async () => {
    await seed('permits', 'rj-name', base())
    await expect(
      as('managerA').update('permits', 'rj-name', { engineering: rejected('managerB') })
    ).rejects.toMatchObject(denied)
    await as('managerA').update('permits', 'rj-name', { engineering: rejected('managerA') })
  })

  it('lets the raiser answer a rejection and pins the re-approval to the rejector', async () => {
    await seed('permits', 'rj-ok', base({ engineering: rejected('managerA') }))
    await as('memberA').update('permits', 'rj-ok', { engineering: answer(rejected('managerA')) })
    const p = await adminEngine.get(null, 'permits', 'rj-ok')
    expect(p.engineering).toMatchObject({ status: 'pending', reapprover: 'managerA' })
    expect(p.engineering.response.text).toMatch(/Gas test/)
    // The other team's approval is untouched.
    expect(p.operations.status).toBe('approved')
  })

  it('accepts exactly what the app writes (ptw/lib/rejection.js answerBlock)', async () => {
    const r = rejected('managerA')
    await seed('permits', 'rj-app', base({ engineering: r }))
    const block = answerBlock(r, 'Gas test certificate attached', { uid: 'memberA', name: 'Mo' })
    await as('memberA').update('permits', 'rj-app', { engineering: block })
    expect((await adminEngine.get(null, 'permits', 'rj-app')).engineering.reapprover).toBe('managerA')
  })

  it('refuses every malformed or borrowed answer', async () => {
    const r = rejected('managerA')
    const attempts = [
      ['memberB', answer(r, { by: 'memberB' })], // not the raiser
      ['managerB', answer(r, { by: 'managerB' })], // a manager who is not the raiser
      ['managerA', answer(r, { by: 'managerA' })], // the rejector answering their own rejection
      ['memberA', answer(r, { reapprover: 'managerB' })], // sent to a friendlier approver
      ['memberA', answer(r, { reapprover: '' })], // sent to the whole department
      ['memberA', answer(r, { text: '   ' })], // no counter comment
      ['memberA', answer(r, { by: 'memberB' })], // answered in someone else's name
      ['memberA', { ...answer(r), rejection: { ...answer(r).rejection, note: 'Looks fine' } }], // rejection rewritten
      ['memberA', { ...answer(r), by: 'memberA', at: AT }], // answer that records a decision
      ['memberA', { ...answer(r), approvedOverride: true }], // something riding along
      ['memberA', { ...answer(r), status: 'approved' }], // approving instead of answering
    ]
    for (const [i, [uid, block]] of attempts.entries()) {
      await seed('permits', `rj-bad-${i}`, base({ engineering: r }))
      await expect(
        as(uid).update('permits', `rj-bad-${i}`, { engineering: block }),
        `${i} ${uid}`
      ).rejects.toMatchObject(denied)
      expect((await adminEngine.get(null, 'permits', `rj-bad-${i}`)).engineering.status, `${i}`).toBe('rejected')
    }
  })

  it('refuses an answer that also reopens the other team’s decision or edits the permit', async () => {
    const r = rejected('managerA')
    await seed('permits', 'rj-more', base({ engineering: r }))
    for (const extra of [{ operations: { status: 'pending' } }, { jobDescription: 'Something else' }]) {
      await expect(
        as('memberA').update('permits', 'rj-more', { engineering: answer(r), ...extra }),
        JSON.stringify(extra)
      ).rejects.toMatchObject(denied)
    }
  })

  it('leaves the re-approval to the rejector alone: not another manager, not an unpin', async () => {
    const r = rejected('managerA')
    await seed('permits', 'rj-pin', base({ engineering: answer(r) }))
    // Another manager can neither decide nor redirect it.
    await expect(
      as('managerB').update('permits', 'rj-pin', { engineering: approvedBy('managerB') })
    ).rejects.toMatchObject(denied)
    await expect(
      as('managerB').update('permits', 'rj-pin', { engineering: { ...answer(r), reapprover: 'managerB' } })
    ).rejects.toMatchObject(denied)
    await expect(
      // update merges nested fields, so this is how the pin is cleared.
      as('managerB').update('permits', 'rj-pin', { 'engineering.reapprover': '' })
    ).rejects.toMatchObject(denied)
    // Not even by the raiser, who asked for it.
    await expect(
      as('memberA').update('permits', 'rj-pin', { engineering: approvedBy('memberA') })
    ).rejects.toMatchObject(denied)
    // The rejector decides.
    await as('managerA').update('permits', 'rj-pin', { engineering: approvedBy('managerA') })
    expect((await adminEngine.get(null, 'permits', 'rj-pin')).engineering.status).toBe('approved')
  })

  it('lets an Administrator answer for a raiser who has left', async () => {
    const r = rejected('managerA')
    await seed('permits', 'rj-admin-answer', base({ engineering: r }))
    await as('adminA').update('permits', 'rj-admin-answer', { engineering: answer(r, { by: 'adminA' }) })
  })

  it('lets an Administrator decide a pinned permit, so one is never stuck', async () => {
    await seed('permits', 'rj-admin', base({ engineering: answer(rejected('managerA')) }))
    await as('adminA').update('permits', 'rj-admin', { engineering: approvedBy('adminA') })
  })

  it('holds a rejected closure to the same rules', async () => {
    const r = rejected('managerA', 'Area not cleaned')
    const closure = (eng) => ({ requestedBy: 'memberA', engineering: eng, operations: approvedBy('managerB') })
    await seed('permits', 'rj-close', base({
      engineering: approvedBy('managerA'),
      closure: closure(r),
      storedStatus: 'in_progress',
    }))
    await expect(
      as('memberA').update('permits', 'rj-close', { 'closure.engineering': answer(r, { reapprover: 'managerB' }) })
    ).rejects.toMatchObject(denied)
    // Starting the closure again instead of answering it is a manager's reset, not the raiser's.
    await expect(
      as('memberA').update('permits', 'rj-close', { closure: { requestedBy: 'memberA', engineering: { status: 'pending' }, operations: { status: 'pending' } } })
    ).rejects.toMatchObject(denied)
    await as('memberA').update('permits', 'rj-close', { 'closure.engineering': answer(r) })
    await expect(
      as('managerB').update('permits', 'rj-close', { 'closure.engineering': approvedBy('managerB') })
    ).rejects.toMatchObject(denied)
    await as('managerA').update('permits', 'rj-close', { 'closure.engineering': approvedBy('managerA') })
    expect((await adminEngine.get(null, 'permits', 'rj-close')).closure.engineering.status).toBe('approved')
  })
})
