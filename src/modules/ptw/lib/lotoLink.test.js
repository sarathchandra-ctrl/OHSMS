import { describe, expect, it } from 'vitest'
import { lockStateLabel, lotoFields, needsLotoProcedure, procedureLabel, proceduresForSite } from './lotoLink'

describe('the LOTO procedure on an electrical permit', () => {
  it('is asked for electrical work only', () => {
    expect(needsLotoProcedure('Electrical Work')).toBe(true)
    expect(needsLotoProcedure('Hot Work')).toBe(false)
    expect(needsLotoProcedure('')).toBe(false)
  })

  it('offers the approved procedures of the selected site, in code order', () => {
    const procs = [
      { id: 'b', siteId: 's1', status: 'approved', procedureCode: 'LOTO-10' },
      { id: 'a', siteId: 's1', status: 'approved', procedureCode: 'LOTO-2' },
      { id: 'd', siteId: 's1', status: 'draft', procedureCode: 'LOTO-1' },
      { id: 'o', siteId: 's2', status: 'approved', procedureCode: 'LOTO-3' },
    ]
    expect(proceduresForSite(procs, 's1').map((p) => p.id)).toEqual(['a', 'b'])
    expect(proceduresForSite(procs, '')).toEqual([])
  })

  it('stores the procedure id, code and equipment, or blanks', () => {
    expect(lotoFields({ id: 'a', procedureCode: 'LOTO-2', equipment: 'Panel 1' })).toEqual({
      lotoProcedureId: 'a', lotoProcedureCode: 'LOTO-2', lotoEquipment: 'Panel 1',
    })
    expect(lotoFields(null).lotoProcedureId).toBe('')
    expect(procedureLabel({ procedureCode: 'LOTO-2', equipment: 'Panel 1' })).toBe('LOTO-2 — Panel 1')
  })

  it('words the live lock state', () => {
    expect(lockStateLabel({ lotoLockStatus: 'partial', lotoLockedCount: 1, lotoPointCount: 3 })).toBe('Partly locked (1 of 3 points)')
    expect(lockStateLabel({})).toBe('Lock state not available')
  })
})
