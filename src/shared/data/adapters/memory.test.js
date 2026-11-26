import { defineDataContract } from './contractSuite'
import { createMemoryAdapter } from './memory'

const tick = () => new Promise((r) => setTimeout(r, 0))

defineDataContract(() => createMemoryAdapter(), { tick, nullMatchesMissing: false, isolated: true })

describe('memory: deleteField where Firestore refuses it', () => {
  it('refuses a field delete as an array element, rather than storing a hole', async () => {
    const d = createMemoryAdapter()
    await expect(d.set('things', 'x', { list: ['a', d.deleteField()] })).rejects.toMatchObject({
      code: 'invalid-argument',
    })
  })
})
