import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { onSiteCreated, notifySiteCreated, _clearSiteHooks } from './siteHooks'

const site = (id = 's1') => ({ id, name: `Site ${id}` })

beforeEach(() => _clearSiteHooks())
afterEach(() => vi.restoreAllMocks())

describe('onSiteCreated', () => {
  it('runs a registered hook with the new sites', async () => {
    const seen = []
    onSiteCreated('a', (sites) => seen.push({ ids: sites.map((s) => s.id) }))
    await notifySiteCreated([site('s1'), site('s2')], { name: 'Alice' })
    expect(seen).toEqual([{ ids: ['s1', 's2'] }])
  })

  it('awaits async hooks before returning', async () => {
    let done = false
    onSiteCreated('a', async () => {
      await new Promise((r) => setTimeout(r, 10))
      done = true
    })
    await notifySiteCreated([site()])
    expect(done).toBe(true)
  })

  it('runs every registered module', async () => {
    const ran = []
    onSiteCreated('a', () => ran.push('a'))
    onSiteCreated('b', () => ran.push('b'))
    await notifySiteCreated([site()])
    expect(ran.sort()).toEqual(['a', 'b'])
  })

  // A module re-evaluated by hot reload or a re-imported chunk would otherwise
  // stack a second copy and provision everything twice per site.
  it('replaces a hook registered twice under the same name', async () => {
    let calls = 0
    onSiteCreated('cctv', () => { calls += 1 })
    onSiteCreated('cctv', () => { calls += 1 })
    await notifySiteCreated([site()])
    expect(calls).toBe(1)
  })

  it('can be unregistered', async () => {
    let calls = 0
    const off = onSiteCreated('a', () => { calls += 1 })
    off()
    await notifySiteCreated([site()])
    expect(calls).toBe(0)
  })
})

describe('notifySiteCreated never breaks the site creation', () => {
  // The site is already written by the time hooks run. An error escaping here
  // would report a successful creation as failed, and the retry would make two.
  it('swallows a throwing hook', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    onSiteCreated('bad', () => { throw new Error('boom') })
    await expect(notifySiteCreated([site()])).resolves.toBeUndefined()
  })

  it('swallows a rejecting async hook', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    onSiteCreated('bad', async () => { throw new Error('boom') })
    await expect(notifySiteCreated([site()])).resolves.toBeUndefined()
  })

  it('still runs the other modules when one fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let good = 0
    onSiteCreated('bad', () => { throw new Error('boom') })
    onSiteCreated('good', () => { good += 1 })
    await notifySiteCreated([site()])
    expect(good).toBe(1)
  })

  it('names the failing module in the warning, so it is diagnosable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onSiteCreated('cctv', () => { throw new Error('boom') })
    await notifySiteCreated([site()])
    expect(warn.mock.calls[0][0]).toContain('cctv')
  })
})

describe('notifySiteCreated does nothing when there is nothing to do', () => {
  it('skips with no sites', async () => {
    let calls = 0
    onSiteCreated('a', () => { calls += 1 })
    await notifySiteCreated([])
    await notifySiteCreated()
    expect(calls).toBe(0)
  })
})
