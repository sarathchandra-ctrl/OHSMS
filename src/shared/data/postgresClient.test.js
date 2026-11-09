import { describe, expect, it, vi } from 'vitest'
import { onSnapshot } from './postgresClient'
import { dataProvider } from './index'

vi.mock('./index', () => ({
  dataProvider: { subscribe: vi.fn(), subscribeDoc: vi.fn() },
}))

describe('subscription callback contract', () => {
  it('rejects missing callbacks before registering a listener that would leave a screen loading', () => {
    for (const target of [
      { kind: 'doc', path: 'settings/entitlements', id: 'entitlements' },
      { kind: 'collection', path: 'users', opts: {} },
    ]) {
      expect(() => onSnapshot(target)).toThrow('onSnapshot requires a callback function')
      expect(() => onSnapshot(target, 'not-a-callback')).toThrow(TypeError)
    }
    expect(dataProvider.subscribe).not.toHaveBeenCalled()
    expect(dataProvider.subscribeDoc).not.toHaveBeenCalled()
  })
})
