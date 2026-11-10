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
