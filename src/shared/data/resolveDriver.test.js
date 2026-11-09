import { describe, expect, it } from 'vitest'
import {
  RESERVED_DATA_DRIVERS,
  UnimplementedDataDriverError,
  resolveDataDriver,
} from './resolveDriver'

const registered = { postgres: { name: 'postgres' }, memory: { name: 'memory' } }

describe('resolveDataDriver', () => {
  it('defaults to postgres', () => {
    expect(resolveDataDriver(undefined, registered)).toBe('postgres')
    expect(resolveDataDriver('', registered)).toBe('postgres')
    expect(resolveDataDriver('  POSTGRES  ', registered)).toBe('postgres')
  })

  it('selects the memory driver when asked', () => {
    expect(resolveDataDriver('memory', registered)).toBe('memory')
  })

  it('treats an unknown name as a typo and stays on postgres', () => {
    expect(resolveDataDriver('mysql', registered)).toBe('postgres')
  })

  it.each(RESERVED_DATA_DRIVERS)(
    'refuses %s instead of opening another database under that name',
    (name) => {
      expect(RESERVED_DATA_DRIVERS).toEqual(['supabase'])
      let caught
      try {
        resolveDataDriver(name, registered)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(UnimplementedDataDriverError)
      expect(caught.driver).toBe(name)
      expect(caught.message).toContain('will not fall back to another database')
    }
  )

  it('normalises the reserved name before refusing', () => {
    expect(() => resolveDataDriver('  Supabase ', registered)).toThrow(UnimplementedDataDriverError)
  })

  it('selects postgres once that adapter is registered', () => {
    expect(resolveDataDriver('postgres', registered)).toBe('postgres')
    expect(resolveDataDriver('  POSTGRES ', registered)).toBe('postgres')
  })

  it('prefers a registered adapter when the name is still on the reserved list', () => {
    // Registration has to win. Otherwise the change that adds the adapter
    // and forgets to edit RESERVED_DATA_DRIVERS ships a build that throws
    // on the driver it just gained.
    const withPostgres = { ...registered, postgres: { name: 'postgres' } }
    expect(resolveDataDriver('postgres', withPostgres)).toBe('postgres')
  })
})
