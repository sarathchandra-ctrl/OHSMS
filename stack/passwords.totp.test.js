import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { applySchema, createEngine } from './engine.mjs'
import {
  bootstrapOrganization,
  completeTotpSignIn,
  confirmTotpEnrollment,
  createMember,
  disableOwnTotp,
  resetMemberTotp,
  signInWithPassword,
  startTotpEnrollment,
  totpStatus,
} from './passwords.mjs'
import { stepAt, totpCode } from './totp.mjs'

// Two-step login driven the way someone holding only the password would drive it.
const MASTER = Buffer.alloc(32, 7).toString('base64')
const ADMIN = { email: 'ana@example.test', password: 'first-admin-pass-1' }
const T0 = Date.UTC(2026, 10, 10, 6, 0, 0)
let engine
let db
let adminUid

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
  adminUid = (await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })).uid
})

const codeAt = (secret, ms) => totpCode(secret, stepAt(ms))
const profile = (uid) => engine.get(null, 'users', uid)

async function enrol(uid, nowMs = T0) {
  const started = await startTotpEnrollment(engine, db, { uid, master: MASTER })
  expect(started).toMatchObject({ ok: true })
  expect(started.uri).toMatch(/^otpauth:\/\/totp\//)
  const done = await confirmTotpEnrollment(engine, db, {
    uid,
    code: codeAt(started.secret, nowMs),
    master: MASTER,
    nowMs,
  })
  expect(done).toEqual({ ok: true })
  return started.secret
}

describe('setting up', () => {
  it('turns on only with a code from the new secret', async () => {
    const started = await startTotpEnrollment(engine, db, { uid: adminUid, master: MASTER })
    expect(
      await confirmTotpEnrollment(engine, db, {
        uid: adminUid,
        code: '000000',
        master: MASTER,
        nowMs: T0,
      })
    ).toMatchObject({ ok: false, reason: 'code' })
    expect((await totpStatus(db, { uid: adminUid })).enabled).toBe(false)
    await confirmTotpEnrollment(engine, db, {
      uid: adminUid,
      code: codeAt(started.secret, T0),
      master: MASTER,
      nowMs: T0,
    })
    expect((await totpStatus(db, { uid: adminUid })).enabled).toBe(true)
    expect((await profile(adminUid)).mfaEnabled).toBe(true)
  })

  it('keeps the secret out of the stored row and the profile', async () => {
    const secret = await enrol(adminUid)
    const row = await db
      .prepare('SELECT secret FROM auth_totp WHERE uid = ?')
      .bind(adminUid)
      .first()
    expect(row.secret).not.toContain(secret)
    expect(JSON.stringify(await profile(adminUid))).not.toContain(secret)
  })

  it('refuses a second setup over a working one, and setup with no master', async () => {
    await enrol(adminUid)
    expect(await startTotpEnrollment(engine, db, { uid: adminUid, master: MASTER })).toMatchObject({
      reason: 'already-on',
    })
    const other = await createMember(engine, db, {
      uid: adminUid,
      email: 'bo@example.test',
      name: 'Bo',
      role: 'member',
      password: 'temporary-pass-1',
    })
    expect(await startTotpEnrollment(engine, db, { uid: other.uid, master: MASTER })).toMatchObject(
      {
        reason: 'not-allowed',
      }
    )
  })
})

describe('signing in', () => {
  it('gives a ticket, not a session, for the right password', async () => {
    await enrol(adminUid)
    const first = await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })
    expect(first).toMatchObject({ ok: true, mfa: true })
    expect(first.ticket.length).toBeGreaterThan(20)
  })

  it('opens a session for the current code, once', async () => {
    const secret = await enrol(adminUid, T0)
    const later = T0 + 5 * 60 * 1000
    const { ticket } = await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })
    const code = codeAt(secret, later)
    const ok = await completeTotpSignIn(engine, db, { ticket, code, master: MASTER, nowMs: later })
    expect(ok).toEqual({ ok: true, uid: adminUid })
    // The ticket is spent, and the same code will not open a second session.
    expect(
      (await completeTotpSignIn(engine, db, { ticket, code, master: MASTER, nowMs: later })).reason
    ).toBe('ticket')
    const again = await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })
    expect(
      (
        await completeTotpSignIn(engine, db, {
          ticket: again.ticket,
          code,
          master: MASTER,
          nowMs: later,
        })
      ).ok
    ).toBe(false)
  })

  it('burns a ticket after a handful of wrong codes', async () => {
    const secret = await enrol(adminUid, T0)
    const later = T0 + 60 * 1000
    const { ticket } = await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })
    for (let i = 0; i < 5; i++) {
      await completeTotpSignIn(engine, db, {
        ticket,
        code: String(100000 + i),
        master: MASTER,
        nowMs: later,
      })
    }
    const right = codeAt(secret, later)
    expect(
      (await completeTotpSignIn(engine, db, { ticket, code: right, master: MASTER, nowMs: later }))
        .reason
    ).toBe('ticket')
  })

  it('refuses an old code and an invented ticket', async () => {
    const secret = await enrol(adminUid, T0)
    const later = T0 + 10 * 60 * 1000
    const { ticket } = await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })
    expect(
      (
        await completeTotpSignIn(engine, db, {
          ticket,
          code: codeAt(secret, T0 + 60_000),
          master: MASTER,
          nowMs: later,
        })
      ).reason
    ).toBe('code')
    expect(
      (
        await completeTotpSignIn(engine, db, {
          ticket: 'x'.repeat(43),
          code: codeAt(secret, later),
          master: MASTER,
          nowMs: later,
        })
      ).reason
    ).toBe('ticket')
  })

  it('treats a secret sealed under another master as a wrong code, not a crash', async () => {
    const secret = await enrol(adminUid, T0)
    const { ticket } = await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })
    const other = Buffer.alloc(32, 9).toString('base64')
    expect(
      (
        await completeTotpSignIn(engine, db, {
          ticket,
          code: codeAt(secret, T0 + 60_000),
          master: other,
          nowMs: T0 + 60_000,
        })
      ).reason
    ).toBe('code')
  })
})

describe('turning it off', () => {
  it('needs a current code, and is refused while an admin requires it', async () => {
    const secret = await enrol(adminUid, T0)
    const later = T0 + 2 * 60 * 1000
    expect(
      (
        await disableOwnTotp(engine, db, {
          uid: adminUid,
          code: '123456',
          master: MASTER,
          nowMs: later,
        })
      ).reason
    ).toBe('code')
    await engine.commit(null, [
      { type: 'update', path: 'users', id: adminUid, data: { mfaRequired: true } },
    ])
    expect(
      (
        await disableOwnTotp(engine, db, {
          uid: adminUid,
          code: codeAt(secret, later),
          master: MASTER,
          nowMs: later,
        })
      ).reason
    ).toBe('required')
    await engine.commit(null, [
      { type: 'update', path: 'users', id: adminUid, data: { mfaRequired: false } },
    ])
    expect(
      await disableOwnTotp(engine, db, {
        uid: adminUid,
        code: codeAt(secret, later),
        master: MASTER,
        nowMs: later,
      })
    ).toEqual({ ok: true })
    expect((await profile(adminUid)).mfaEnabled).toBe(false)
    expect(
      await signInWithPassword(engine, db, { ...ADMIN, ip: '198.51.100.1' })
    ).not.toHaveProperty('mfa')
  })

  it('lets only an admin reset someone else (a lost phone)', async () => {
    const bo = await createMember(engine, db, {
      uid: adminUid,
      email: 'bo@example.test',
      name: 'Bo',
      role: 'member',
      password: 'temporary-pass-1',
    })
    await enrol(adminUid)
    expect(await resetMemberTotp(engine, db, { uid: bo.uid, targetUid: adminUid })).toMatchObject({
      reason: 'not-admin',
    })
    expect((await totpStatus(db, { uid: adminUid })).enabled).toBe(true)
    expect(await resetMemberTotp(engine, db, { uid: adminUid, targetUid: adminUid })).toEqual({
      ok: true,
    })
    expect((await totpStatus(db, { uid: adminUid })).enabled).toBe(false)
    expect((await profile(adminUid)).mfaEnabled).toBe(false)
  })
})
