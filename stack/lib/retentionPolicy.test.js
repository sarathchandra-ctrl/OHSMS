import { describe, it, expect } from 'vitest'
import { PURGEABLE } from './retention.js'
import { SUBJECT_SOURCES, STATUTORY, ERASABLE } from './subjectData.js'
import {
  NEEDS_LEGAL_SIGN_OFF,
  LIVE_AGE_PURGE_ENABLED,
  RECORD_CLASSES,
  counselSignOffQuestions,
  recycleBinPurgeablePaths,
  planLiveAgePurge,
  policyCoversSubjectSources,
} from './retentionPolicy.js'

describe('the period table is a proposal, not a purge', () => {
  it('marks unsigned personal-data rows so a number cannot sneak in as policy', () => {
    const personal = RECORD_CLASSES.filter((r) => r.class !== 'operational')
    expect(personal.length).toBeGreaterThan(0)
    for (const row of personal) {
      expect(row.proposedPeriod, row.path).toBe(NEEDS_LEGAL_SIGN_OFF)
      expect(row.livePurge, row.path).toBe(false)
    }
  })

  it('never enables live age-purge of statutory classes', () => {
    expect(LIVE_AGE_PURGE_ENABLED).toBe(false)
    for (const row of RECORD_CLASSES.filter((r) => r.class === STATUTORY)) {
      expect(row.livePurge, row.path).toBe(false)
    }
  })

  it('asks counsel a concrete question per unsigned class, not a blank "please review"', () => {
    const qs = counselSignOffQuestions()
    expect(qs.length).toBeGreaterThan(5)
    expect(qs.every((q) => q.question && q.currentPeriod === NEEDS_LEGAL_SIGN_OFF)).toBe(true)
    expect(qs.map((q) => q.path)).toEqual(
      expect.arrayContaining(['injuries', 'auditLogs', 'trainingRecords'])
    )
  })
})

describe('Recycle Bin sweep stays the only scheduled destroyer', () => {
  it('matches PURGEABLE, so this table cannot invent a new auto-delete class', () => {
    expect(recycleBinPurgeablePaths().sort()).toEqual(PURGEABLE.map((p) => p.collection).sort())
  })

  it('does not put erasable-but-unsigned sources onto the nightly sweep', () => {
    const purgeable = new Set(recycleBinPurgeablePaths())
    for (const src of SUBJECT_SOURCES.filter((s) => s.retention === ERASABLE)) {
      expect(purgeable.has(src.path), src.path).toBe(false)
    }
  })
})

describe('planLiveAgePurge is a sealed door', () => {
  const docs = [{ id: 'a' }, { id: 'b' }]

  it('returns nothing to destroy while the flag is off', () => {
    const statutory = RECORD_CLASSES.find((r) => r.path === 'injuries')
    const out = planLiveAgePurge(docs, statutory)
    expect(out.purge).toEqual([])
    expect(out.keep).toHaveLength(2)
  })

  it('would still refuse a statutory row if someone flipped livePurge on the row', () => {
    const row = { ...RECORD_CLASSES.find((r) => r.path === 'injuries'), livePurge: true }
    expect(row.class).toBe(STATUTORY)
    const out = planLiveAgePurge(docs, row)
    expect(out.purge).toEqual([])
    expect(LIVE_AGE_PURGE_ENABLED).toBe(false)
  })
})

describe('the table covers the subject-access inventory', () => {
  it('has a root row for every SUBJECT_SOURCES path', () => {
    expect(policyCoversSubjectSources()).toEqual([])
  })
})
