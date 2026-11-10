import { describe, expect, it } from 'vitest'
import { answerBlock, canAnswer, pinnedTo, stageBlock } from './rejection'
import { canActForTeam, TEAMS } from './permissions'

const rejected = { status: 'rejected', by: 'mgr1', byName: 'Mia', at: '2026-11-10T06:00:00.000Z', note: 'No gas test' }
const raiser = { uid: 'tech1', roles: ['technician'] }

describe('answering a rejection', () => {
  it('sends it back pending, pinned to the person who rejected, with both sides kept', () => {
    const b = answerBlock(rejected, '  Gas test attached  ', { uid: 'tech1', name: 'Tom' }, 'T')
    expect(b).toMatchObject({
      status: 'pending',
      by: null,
      at: null,
      reapprover: 'mgr1',
      reapproverName: 'Mia',
      rejection: { by: 'mgr1', note: 'No gas test', at: rejected.at },
      response: { by: 'tech1', byName: 'Tom', at: 'T', text: 'Gas test attached' },
    })
    expect(pinnedTo(b)).toBe('mgr1')
  })

  it('refuses an empty answer, an overlong one, and anything that is not a rejection', () => {
    expect(() => answerBlock(rejected, '   ', { uid: 'tech1' })).toThrow(/answer/)
    expect(() => answerBlock(rejected, 'x'.repeat(2001), { uid: 'tech1' })).toThrow(/2000/)
    expect(() => answerBlock({ ...rejected, status: 'approved' }, 'ok', { uid: 'tech1' })).toThrow()
    expect(() => answerBlock({ ...rejected, by: '' }, 'ok', { uid: 'tech1' })).toThrow()
  })

  it('lets the raiser answer, or an Administrator; never the rejector, nor what is not rejected', () => {
    const permit = { createdBy: 'tech1' }
    expect(canAnswer(raiser, permit, rejected)).toBe(true)
    expect(canAnswer({ uid: 'tech2' }, permit, rejected)).toBe(false)
    expect(canAnswer({ uid: 'adm' }, permit, rejected, { admin: true })).toBe(true)
    // The manager who rejected it does not answer their own rejection.
    expect(canAnswer({ uid: 'mgr1' }, permit, rejected, { admin: true })).toBe(false)
    expect(canAnswer({ uid: 'mgr1' }, { createdBy: 'mgr1' }, rejected)).toBe(false)
    expect(canAnswer(raiser, permit, { ...rejected, status: 'approved' })).toBe(false)
  })

  it('reads the opening and the closure blocks', () => {
    const p = { engineering: { status: 'a' }, closure: { operations: { status: 'b' } } }
    expect(stageBlock(p, 'permit', 'engineering').status).toBe('a')
    expect(stageBlock(p, 'closure', 'operations').status).toBe('b')
    expect(stageBlock(p, 'extension', 'operations')).toBeNull()
  })
})

describe('who decides a re-approval', () => {
  const pinned = answerBlock(rejected, 'Fixed', { uid: 'tech1' })
  const manager = (uid) => ({ uid, roles: ['admin'], platformRole: 'manager' })

  it('is the rejector alone, not every manager', () => {
    expect(canActForTeam(manager('mgr1'), {}, TEAMS.ENGINEERING, pinned)).toBe(true)
    expect(canActForTeam(manager('mgr2'), {}, TEAMS.ENGINEERING, pinned)).toBe(false)
    expect(canActForTeam(raiser, {}, TEAMS.ENGINEERING, pinned)).toBe(false)
  })

  it('still lets the platform Administrator decide, so a permit is never stuck', () => {
    expect(canActForTeam({ uid: 'adm', roles: ['admin'], platformRole: 'admin' }, {}, TEAMS.ENGINEERING, pinned)).toBe(true)
  })

  it('is unchanged for a decision that is not pinned', () => {
    expect(canActForTeam(manager('mgr2'), {}, TEAMS.ENGINEERING, { status: 'pending' })).toBe(true)
    expect(canActForTeam(manager('mgr2'), {}, TEAMS.ENGINEERING)).toBe(true)
  })
})
