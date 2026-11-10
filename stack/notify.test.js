import { describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { applySchema, createEngine } from './engine.mjs'
import { createOwnStackHandler } from './handler.mjs'
import { signSession } from './session.mjs'
import { nodeRequest, nodeResponse } from '../worker/bridge.js'
import { digestFor, eventMessages, managersOf, notifySettings, sitesOf } from './lib/notify.js'
import { MAX_EVENT_MAILS, digestDay, notifyChanges, runDailyNotices, runSixHourly, sendDigests } from './notify.mjs'

const origin = 'https://ehs.example.com'
const SECRET = 's'.repeat(40)
const person = (id, extra = {}) => ({
  id,
  status: 'approved',
  role: 'member',
  email: `${id}@example.com`,
  name: `${id[0].toUpperCase()}${id.slice(1)} Person`,
  ...extra,
})
const sites = [
  { id: 's1', name: 'North Plant', region: 'North' },
  { id: 's2', name: 'South Plant', region: 'South' },
]
const users = [
  person('admin', { role: 'admin' }),
  person('north', { role: 'manager', access: { sites: ['s1'] } }),
  person('south', { role: 'manager', access: { regions: ['South'] } }),
  person('worker', { siteId: 's1' }),
  person('pending', { role: 'manager', status: 'pending', access: { sites: ['s1'] } }),
  person('fresh', { role: 'manager', mustChangePassword: true, access: { sites: ['s1'] } }),
]
const ctx = (extra = {}) => ({ users, sites, org: {}, origin, actorUid: 'worker', ...extra })
const recipients = (msgs) => msgs.map((m) => m.to).sort()

describe('who looks after a site', () => {
  it('grants by site, region and home site; admins everywhere', () => {
    expect([...sitesOf(users[1], sites)]).toEqual(['s1'])
    expect([...sitesOf(users[2], sites)]).toEqual(['s2'])
    expect([...sitesOf(users[0], sites)].sort()).toEqual(['s1', 's2'])
  })

  it('leaves out anyone who cannot use the app today', () => {
    expect(managersOf('s1', users, sites).map((u) => u.id).sort()).toEqual(['admin', 'north'])
  })
})

describe('event mail', () => {
  const incident = {
    refNo: 'INC-0007',
    siteId: 's1',
    type: 'near_miss',
    severity: 'Low',
    incidentDate: '2026-11-09',
    description: 'NARRATIVE-MUST-NOT-LEAK',
    injuredName: 'INJURED-MUST-NOT-LEAK',
    capa: [],
  }

  it('tells the managers of the site, and the notification email, of a new incident', () => {
    const msgs = eventMessages([{ path: 'incidents', id: 'i1', before: null, after: incident }], ctx({ org: { notificationEmail: 'safety@example.com' } }))
    expect(recipients(msgs)).toEqual(['admin@example.com', 'north@example.com', 'safety@example.com'])
    expect(msgs[0].subject).toBe('New incident INC-0007 at North Plant')
    expect(msgs[0].text).toContain(`${origin}/incidents/i1`)
    expect(msgs[0].text).toContain('9 Nov 2026')
  })

  it('never carries the narrative, a name of someone hurt, or an action’s text', () => {
    const after = { ...incident, capa: [{ id: 'a1', ownerUid: 'south', title: 'ACTION-TEXT-MUST-NOT-LEAK', description: 'ACTION-TEXT-MUST-NOT-LEAK', dueDate: '2026-11-20' }] }
    const msgs = eventMessages([{ path: 'incidents', id: 'i1', before: null, after }], ctx())
    const all = msgs.map((m) => m.subject + m.text).join('\n')
    expect(all).not.toMatch(/MUST-NOT-LEAK/)
  })

  it('does not mail illnesses, or anything else outside the list', () => {
    const msgs = eventMessages(
      [
        { path: 'illnesses', id: 'x', before: null, after: { siteId: 's1', diagnosis: 'x' } },
        { path: 'injuries', id: 'y', before: null, after: { siteId: 's1' } },
      ],
      ctx()
    )
    expect(msgs).toEqual([])
  })

  it('does not mail the person who made the change', () => {
    const msgs = eventMessages([{ path: 'incidents', id: 'i1', before: null, after: incident }], ctx({ actorUid: 'north' }))
    expect(recipients(msgs)).toEqual(['admin@example.com'])
  })

  it('tells an action owner once, when the action becomes theirs', () => {
    const before = { ...incident, capa: [{ id: 'a1', ownerUid: '' }] }
    const after = { ...incident, capa: [{ id: 'a1', ownerUid: 'south', dueDate: '2026-11-20' }] }
    const first = eventMessages([{ path: 'incidents', id: 'i1', before, after }], ctx())
    expect(recipients(first)).toEqual(['south@example.com'])
    expect(first[0].text).toContain('Due: 20 Nov 2026')
    expect(eventMessages([{ path: 'incidents', id: 'i1', before: after, after }], ctx())).toEqual([])
  })

  it('sends a new permit to the people on it and the site’s managers', () => {
    const msgs = eventMessages([{ path: 'permits', id: 'p1', before: null, after: { permitNo: 'PTW-1', siteId: 's2', createdBy: 'worker', assignedEngineer: 'south' } }], ctx({ actorUid: 'admin' }))
    expect(recipients(msgs)).toEqual(['south@example.com', 'worker@example.com'])
  })

  it('follows an audit finding between auditee and auditor', () => {
    const f = { docId: 'AUD-3', auditeeUid: 'worker', createdByUid: 'north' }
    const step = (from, to, actorUid) =>
      recipients(
        eventMessages([{ path: 'auditFindings', id: 'f', before: from && { ...f, status: from }, after: { ...f, status: to } }], ctx({ actorUid }))
      )
    expect(step(null, 'Reported', 'north')).toEqual(['worker@example.com'])
    expect(step('Reported', 'Submitted for Verification', 'worker')).toEqual(['north@example.com'])
    expect(step('Submitted for Verification', 'Reported', 'north')).toEqual(['worker@example.com'])
    expect(step('Submitted for Verification', 'Closed', 'north')).toEqual(['worker@example.com'])
    expect(step('Reported', 'Reported', 'north')).toEqual([])
  })

  it('tells a person of training assigned to them', () => {
    const msgs = eventMessages(
      [{ path: 'trainingAssignments', id: 't', before: null, after: { employeeUid: 'south', status: 'assigned', courseName: 'Working at height' } }],
      ctx({ actorUid: 'admin' })
    )
    expect(msgs.map((m) => m.subject)).toEqual(['Training assigned: Working at height'])
  })

  it('sends nothing of a kind the organization turned off', () => {
    const org = { notifications: { incident: false } }
    expect(notifySettings(org)).toMatchObject({ incident: false, action: true, digest: true })
    expect(eventMessages([{ path: 'incidents', id: 'i1', before: null, after: incident }], ctx({ org }))).toEqual([])
  })

  it('skips deleted records', () => {
    expect(eventMessages([{ path: 'incidents', id: 'i1', before: null, after: { ...incident, deletedAt: '2026-11-10' } }], ctx())).toEqual([])
  })
})

describe('the daily summary', () => {
  const today = '2026-11-10'
  const data = {
    sites,
    incidents: [
      { refNo: 'INC-1', capa: [{ id: 'a', ownerUid: 'worker', dueDate: '2026-11-08' }, { id: 'b', ownerUid: 'worker', dueDate: '2026-12-30' }, { id: 'c', ownerUid: 'worker', dueDate: '2026-11-01', status: 'closed' }] },
    ],
    trainingAssignments: [{ employeeUid: 'worker', status: 'assigned', courseName: 'Fire safety', dueDate: '2026-11-15' }],
    trainingRecords: [
      { employeeUid: 'worker', courseId: 'c1', courseName: 'First aid', completedOn: '2024-01-01', expiresOn: '2026-11-01' },
      { employeeUid: 'worker', courseId: 'c1', courseName: 'First aid', completedOn: '2026-10-01', expiresOn: '2028-10-01' },
    ],
    auditFindings: [{ docId: 'AUD-1', auditeeUid: 'worker', status: 'Reported' }],
    extinguishers: [
      { extId: 'EXT-1', siteId: 's1', dateOfNextRefill: '2026-11-12' },
      { extId: 'EXT-2', siteId: 's2', dateOfNextRefill: '2026-11-12' },
    ],
    permits: [{ permitNo: 'PTW-9', siteId: 's1', storedStatus: 'draft' }],
    documents: [{ title: 'Fire plan', siteId: 's1', reviewDate: '2026-11-20' }],
  }

  it('lists a person’s own due and overdue work only', () => {
    const msg = digestFor(users[3], data, { today, origin })
    expect(msg.to).toBe('worker@example.com')
    expect(msg.text).toContain('Corrective action on INC-1: overdue since 8 Nov 2026')
    expect(msg.text).not.toContain('30 Dec 2026')
    expect(msg.text).toContain('Fire safety: due 15 Nov 2026')
    // Renewed since: the old certificate's expiry is not news.
    expect(msg.text).not.toContain('First aid')
    expect(msg.text).toContain('AUD-1: findings to answer')
    expect(msg.text).not.toContain('EXT-1')
    expect(msg.subject).toBe('Your safety summary: 3 items need attention')
  })

  it('adds what is due at a manager’s own sites', () => {
    const msg = digestFor(users[1], data, { today, origin })
    expect(msg.text).toContain('EXT-1 at North Plant: refill due 12 Nov 2026')
    expect(msg.text).not.toContain('EXT-2')
    expect(msg.text).toContain('PTW-9 at North Plant: awaiting approval')
    expect(msg.text).toContain('Fire plan: review due 20 Nov 2026')
  })

  it('is not sent to someone with nothing due, or who opted out', () => {
    expect(digestFor(users[2], { sites }, { today })).toBeNull()
    expect(digestFor({ ...users[3], digestOptOut: true }, data, { today })).toBeNull()
  })

  it('takes the date in India, where it is read', () => {
    expect(digestDay(Date.parse('2026-11-10T20:00:00Z'))).toBe('2026-11-11')
    expect(digestDay(Date.parse('2026-11-10T02:30:00Z'))).toBe('2026-11-10')
  })
})

async function setup() {
  const db = openSqlite()
  await applySchema(db)
  const engine = createEngine(db)
  const seed = (path, id, data) => engine.commit(null, [{ type: 'set', path, id, data, merge: false }])
  for (const u of users) {
    const { id, ...rest } = u
    await seed('users', id, rest)
  }
  for (const s of sites) {
    const { id, ...rest } = s
    await seed('sites', id, rest)
  }
  await seed('organization', 'profile', { name: 'Example Co' })
  const outbox = []
  const mail = async (m) => {
    outbox.push(m)
    return { sent: true }
  }
  return { db, engine, seed, outbox, mail }
}

describe('sending', () => {
  it('mails after a commit, through the handler, without the changes in the response', async () => {
    const { db, engine, outbox, mail } = await setup()
    const pending = []
    const handle = createOwnStackHandler({ engine, db, sessionSecret: SECRET, origin, mail, background: (p) => pending.push(p) })
    const { res, done, toResponse } = nodeResponse()
    const after = { employeeUid: 'south', status: 'assigned', courseName: 'Working at height', dueDate: '2026-12-01' }
    await handle(
      nodeRequest(
        new Request(`${origin}/data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signSession(SECRET, { sub: 'admin' })}` },
          body: JSON.stringify({ op: 'commit', ops: [{ type: 'set', path: 'trainingAssignments', id: 't1', data: after, merge: false }] }),
        })
      ),
      res
    )
    await done
    const body = await (await toResponse()).json()
    expect(body.stale).toBe(false)
    expect(body.changes).toBeUndefined()
    await Promise.all(pending)
    expect(outbox.map((m) => m.to)).toEqual(['south@example.com'])
  })

  it('caps one commit’s mail', async () => {
    const { engine, mail, outbox } = await setup()
    const many = Array.from({ length: MAX_EVENT_MAILS + 5 }, (_, i) => ({
      path: 'trainingAssignments',
      id: `t${i}`,
      before: null,
      after: { employeeUid: 'south', status: 'assigned', courseName: 'x' },
    }))
    const out = await notifyChanges(engine, { changes: many, actorUid: 'admin', mail, origin })
    expect(out).toEqual({ belled: MAX_EVENT_MAILS, sent: MAX_EVENT_MAILS, failed: 0, dropped: 5 })
    expect(outbox).toHaveLength(MAX_EVENT_MAILS)
  })

  it('does not read anything for a commit that mails no one', async () => {
    const engine = { list: () => { throw new Error('read') }, get: () => { throw new Error('read') } }
    const out = await notifyChanges(engine, { changes: [{ path: 'checklists', id: 'c', before: null, after: {} }], mail: async () => ({ sent: true }) })
    expect(out.sent).toBe(0)
  })

  it('sends each person one summary a day, and retries one that failed', async () => {
    const { db, engine, seed, outbox } = await setup()
    await seed('auditFindings', 'f1', { docId: 'AUD-1', auditeeUid: 'worker', status: 'Reported' })
    await seed('auditFindings', 'f2', { docId: 'AUD-2', auditeeUid: 'south', status: 'Reported' })
    const now = Date.parse('2026-11-10T02:30:00Z')
    let down = true
    const flaky = async (m) => {
      if (down && m.to === 'south@example.com') return { sent: false }
      outbox.push(m)
      return { sent: true }
    }
    expect(await sendDigests(engine, db, { mail: flaky, origin, now })).toMatchObject({ sent: 1, failed: 1 })
    down = false
    expect(await sendDigests(engine, db, { mail: flaky, origin, now: now + 60_000 })).toMatchObject({ sent: 1, already: 1 })
    expect(outbox.map((m) => m.to).sort()).toEqual(['south@example.com', 'worker@example.com'])
    // The next day is a new summary.
    expect(await sendDigests(engine, db, { mail: flaky, origin, now: now + 24 * 3600 * 1000 })).toMatchObject({ sent: 2 })
  })

  it('sends no summary when the organization turned it off', async () => {
    const { db, engine, seed, mail } = await setup()
    await seed('organization', 'profile', { notifications: { digest: false } })
    expect(await sendDigests(engine, db, { mail, origin })).toEqual({ skipped: 'off' })
  })
})

describe('the personal opt-out', () => {
  it('is a person’s own to set, and no one else’s', async () => {
    const { engine } = await setup()
    const as = (uid) => ({ role: 'ohsms_browser', uid })
    const optOut = (uid, target) =>
      engine.commit(as(uid), [{ type: 'update', path: 'users', id: target, data: { digestOptOut: true } }])
    await optOut('worker', 'worker')
    expect((await engine.get(null, 'users', 'worker')).digestOptOut).toBe(true)
    await expect(optOut('worker', 'south')).rejects.toMatchObject({ code: 'permission-denied' })
    expect((await engine.get(null, 'users', 'south')).digestOptOut).toBeUndefined()
  })
})

describe('the bell', () => {
  it('fills without mail, with the title, one line and the in-app link', async () => {
    const { engine } = await setup()
    const out = await notifyChanges(engine, {
      changes: [{ path: 'auditFindings', id: 'f', before: null, after: { docId: 'AUD-4', auditeeUid: 'worker', createdByUid: 'north', status: 'Reported' } }],
      actorUid: 'north',
      now: Date.parse('2026-11-10T09:00:00Z'),
    })
    expect(out).toMatchObject({ belled: 1, sent: 0 })
    const items = await engine.list(null, 'inbox/worker/items', {})
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'audit',
      title: 'Audit findings for you to answer · AUD-4',
      link: '/audit?view=auditee',
      createdAt: '2026-11-10T09:00:00.000Z',
      readAt: null,
    })
    // The notification email is mailed, never belled: it has no inbox.
    expect(await engine.list(null, 'inbox/north/items', {})).toEqual([])
  })
})

describe('on the clock', () => {
  it('RCA reminders run once per 6-hour slot, and stop when the RCA is done', async () => {
    const { db, engine, seed } = await setup()
    await seed('incidents', 'i1', { refNo: 'IRA-1', siteId: 's1', createdBy: 'worker', lifecycle: 'investigation_team' })
    const t = Date.parse('2026-11-10T01:00:00Z') // 06:30 IST, slot 06
    expect((await runSixHourly(engine, db, { origin, now: t })).rca.belled).toBe(3)
    expect(await runSixHourly(engine, db, { origin, now: t + 3600_000 })).toMatchObject({ skipped: 'slot-done' })
    expect((await runSixHourly(engine, db, { origin, now: t + 6 * 3600_000 })).rca.belled).toBe(3)
    await seed('incidents', 'i1', { refNo: 'IRA-1', siteId: 's1', createdBy: 'worker', stagesDone: { investigation: true } })
    expect((await runSixHourly(engine, db, { origin, now: t + 12 * 3600_000 })).rca.belled).toBe(0)
    expect(await engine.list(null, 'inbox/worker/items', {})).toHaveLength(2)
  })

  it('equipment due is told once per unit and date; uptime once a month, on the 1st', async () => {
    const { db, engine, seed } = await setup()
    await seed('extinguishers', 'e1', { extId: 'EXT-1', siteId: 's1', entity: 'Alpha Ltd', dateOfNextRefill: '2026-12-03', physicalDefects: [] })
    const first = Date.parse('2026-12-01T02:30:00Z')
    const run1 = await runDailyNotices(engine, db, { origin, now: first })
    expect(run1.equipmentDue.belled).toBeGreaterThan(0)
    expect(run1.uptime.belled).toBeGreaterThan(0)
    const run2 = await runDailyNotices(engine, db, { origin, now: first + 24 * 3600_000 })
    expect(run2.equipmentDue.belled).toBe(0)
    expect(run2.uptime).toBeUndefined()
  })
})
