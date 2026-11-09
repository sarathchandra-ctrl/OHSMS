import { describe, expect, it } from 'vitest'
import { dataDriver, dataProvider } from './index'

// Locks the wiring in index.js: with no VITE_DATA_DRIVER, the app talks to
// this installation's server through the postgres adapter.
describe('default data driver', () => {
  it('selects the postgres adapter', () => {
    expect(dataDriver).toBe('postgres')
    expect(typeof dataProvider.get).toBe('function')
    expect(typeof dataProvider.createExclusive).toBe('function')
  })
})
