import { describe, expect, it } from 'vitest'
import { traceLock } from './lockRegister'

const locks = [
  { id: 'l1', lockNo: 'D-1', tagNo: 'RED-1', serviceStatus: 'available' },
  { id: 'l2', lockNo: 'P-7', tagNo: '', serviceStatus: 'out_of_service' },
]

describe('traceLock', () => {
  it('finds a lock by its number or its tag, whatever the case and spacing', () => {
    expect(traceLock(' d-1 ', locks)).toEqual({ kind: 'lock', lock: locks[0] })
    expect(traceLock('red-1', locks).lock.id).toBe('l1')
  })

  it('does not match an empty tag, and says when nothing matches or nothing was typed', () => {
    expect(traceLock('nope', locks).kind).toBe('none')
    expect(traceLock('   ', locks).kind).toBe('empty')
    expect(traceLock('', [{ lockNo: 'X', tagNo: '' }]).kind).toBe('empty')
  })
})
