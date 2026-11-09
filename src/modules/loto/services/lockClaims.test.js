import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Firestore seam. Every function under test either builds an id or hands a
// writer a ref, so a ref that simply records its path is enough to assert on —
// and it keeps the padlock logic testable without an emulator, which matters
// because this is the one control in the app whose failure mode is physical.
vi.mock('../../../shared/data/client.js', () => ({
  collection: (_db, name) => ({ __col: name }),
  doc: (_db, col, id) => ({ __path: `${col}/${id}` }),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: (n) => ({ __limit: n }),
  query: (...parts) => ({ __query: parts }),
  serverTimestamp: () => '__ts',
  where: (f, op, v) => ({ __where: [f, op, v] }),
  writeBatch: vi.fn(),
}))
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../../../shared/org/orgData', () => ({ COLLECTION_READ_CAP: 500 }))

const {
  assertClaimsFree,
  claimId,
  conflictMessage,
  conflicts,
  lockNosHeldBy,
  normaliseLockNos,
  readClaims,
  releaseClaims,
  takeClaims,
} = await import('./lockClaims')

/** A writer that records what it was asked to do, standing in for tx or batch. */
function recorder() {
  return {
    sets: [],
    deletes: [],
    set(ref, data) { this.sets.push({ path: ref.__path, data }) },
    delete(ref) { this.deletes.push(ref.__path) },
  }
}

/** A transaction whose reads answer from a fixture map of path → data. */
function txReading(existing) {
  return {
    reads: [],
    async get(ref) {
      this.reads.push(ref.__path)
      const data = existing[ref.__path]
      return { exists: () => data !== undefined, data: () => data }
    },
  }
}

describe('claimId', () => {
  it('puts the org first so the rules can pin the id to its payload', () => {
    expect(claimId('12')).toBe('org__12')
  })

  it('leaves an ordinary lock number readable', () => {
    expect(claimId('DEPT-045')).toBe('org__DEPT-045')
  })

  it('escapes a slash rather than crashing on an illegal document id', () => {
    // A technician typing "12/A" would otherwise throw inside doc() and take
    // the lock down with it — refusing to apply a padlock over punctuation.
    expect(claimId('12/A')).toBe('org__12%2FA')
  })

  it('keeps the org recoverable as the first segment even when the lock has one', () => {
    expect(claimId('A__B').split('__')[0]).toBe('org')
  })

  it('accepts a number as readily as a string', () => {
    expect(claimId(12)).toBe('org__12')
  })
})

describe('normaliseLockNos', () => {
  it('drops blanks and nullish values', () => {
    expect(normaliseLockNos(['12', '', null, undefined, '13'])).toEqual(['12', '13'])
  })

  it('de-duplicates', () => {
    expect(normaliseLockNos(['12', '12', '13'])).toEqual(['12', '13'])
  })

  it('reconciles 12 and "12" so a claim is not taken under one and sought under the other', () => {
    expect(normaliseLockNos([12, '12'])).toEqual(['12'])
  })

  it('survives no argument at all', () => {
    expect(normaliseLockNos()).toEqual([])
  })
})

describe('conflicts', () => {
  const held = (over) => ({ lockNo: '12', exists: true, data: { procedureId: 'p2' }, ...over })

  it('is silent when nothing holds the lock', () => {
    expect(conflicts([{ lockNo: '12', exists: false, data: null }], 'p1')).toEqual([])
  })

  it('reports a lock held by another procedure', () => {
    expect(conflicts([held()], 'p1')).toHaveLength(1)
  })

  it('does NOT report a lock this procedure already holds', () => {
    // Re-asserting our own claim is how a personal→department swap lands, and
    // the rules permit that update precisely because the holder is unchanged.
    expect(conflicts([held({ data: { procedureId: 'p1' } })], 'p1')).toEqual([])
  })

  it('handles a claim document with no procedureId as somebody else’s', () => {
    // Safer direction: an unattributable claim is a padlock we cannot account
    // for, and handing it out again is the failure this collection prevents.
    expect(conflicts([held({ data: {} })], 'p1')).toHaveLength(1)
  })
})

describe('conflictMessage', () => {
  it('names the equipment the padlock is actually on', () => {
    const msg = conflictMessage({ lockNo: '12', data: { equipment: 'Pump P-101' } })
    expect(msg).toContain('Pump P-101')
    expect(msg).toContain('12')
  })

  it('falls back to the procedure code when the equipment is not recorded', () => {
    expect(conflictMessage({ lockNo: '12', data: { procedureCode: 'LOTO-7' } })).toContain('LOTO-7')
  })

  it('still says the lock is elsewhere when it can name nowhere', () => {
    // "Lock 12 is already in use" was the old message, and it sent people to
    // search the equipment in front of them — the one place it is not.
    expect(conflictMessage({ lockNo: '12', data: {} })).toContain('other equipment')
  })
})

describe('assertClaimsFree', () => {
  it('passes when every padlock is free', () => {
    expect(() => assertClaimsFree([{ lockNo: '12', exists: false }], 'p1')).not.toThrow()
  })

  it('throws with the other machine named', () => {
    expect(() =>
      assertClaimsFree([{ lockNo: '12', exists: true, data: { procedureId: 'p2', equipment: 'Press 4' } }], 'p1'),
    ).toThrow(/Press 4/)
  })
})

describe('readClaims', () => {
  it('reads one document per distinct lock number', async () => {
    const tx = txReading({})
    await readClaims(tx, ['12', '12', '13'])
    expect(tx.reads).toEqual(['lockClaims/org__12', 'lockClaims/org__13'])
  })

  it('reports which are held and by whom', async () => {
    const tx = txReading({ 'lockClaims/org__12': { procedureId: 'p2', equipment: 'Press 4' } })
    const held = await readClaims(tx, ['12', '13'])
    expect(held).toEqual([
      { lockNo: '12', exists: true, data: { procedureId: 'p2', equipment: 'Press 4' } },
      { lockNo: '13', exists: false, data: null },
    ])
  })

  it('reads nothing when there is nothing to claim', async () => {
    const tx = txReading({})
    expect(await readClaims(tx, [])).toEqual([])
    expect(tx.reads).toEqual([])
  })
})

describe('takeClaims', () => {
  let writer
  beforeEach(() => { writer = recorder() })

  it('writes one claim per lock, at the id that carries the number', () => {
    takeClaims(writer, { procedureId: 'p1' }, ['12', '13'])
    expect(writer.sets.map((s) => s.path)).toEqual(['lockClaims/org__12', 'lockClaims/org__13'])
  })


  it('records where to go and look for the padlock', () => {
    takeClaims(
      writer,
      { procedureId: 'p1', equipment: 'Pump P-101', pointKey: 'pt-1', techName: 'R. Nair' },
      ['12'],
    )
    expect(writer.sets[0].data).toMatchObject({
      lockNo: '12',
      procedureId: 'p1',
      equipment: 'Pump P-101',
      pointKey: 'pt-1',
      techName: 'R. Nair',
      holder: 'point',
    })
  })

  it('writes nothing for an empty list', () => {
    takeClaims(writer, { procedureId: 'p1' }, [])
    expect(writer.sets).toEqual([])
  })
})

describe('releaseClaims', () => {
  it('deletes one document per lock', () => {
    const writer = recorder()
    releaseClaims(writer, ['12', '13'])
    expect(writer.deletes).toEqual(['lockClaims/org__12', 'lockClaims/org__13'])
  })

  it('ignores a missing lock number rather than refusing the release', () => {
    // A padlock applied before this collection existed has no claim. Refusing
    // to record its removal because the bookkeeping is absent would be this
    // file's own failure, pointed the other way.
    const writer = recorder()
    releaseClaims(writer, [null, '', undefined])
    expect(writer.deletes).toEqual([])
  })
})

describe('lockNosHeldBy', () => {
  it('finds point locks, box locks and per-point group locks', () => {
    const procedure = {
      isolationPoints: [
        { key: 'a', lockState: { locked: true, techLockNo: '1' } },
        { key: 'b', lockState: { locked: true, techLockNo: '2' } },
      ],
      groupLock: { members: [{ boxLock: '3' }, { locks: { a: '4', b: '5' } }] },
    }
    expect(lockNosHeldBy(procedure)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('ignores a point that is not locked', () => {
    const procedure = {
      isolationPoints: [{ key: 'a', lockState: { locked: false, techLockNo: '1' } }],
    }
    expect(lockNosHeldBy(procedure)).toEqual([])
  })

  it('returns nothing for a procedure with no locks at all', () => {
    expect(lockNosHeldBy({})).toEqual([])
    expect(lockNosHeldBy(null)).toEqual([])
  })
})
