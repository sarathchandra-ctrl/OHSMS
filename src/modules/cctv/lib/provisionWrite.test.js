import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Firestore seam. Everything asserted here is about WHICH document gets
// written and how many times, so a ref that records its path is the whole of
// what a fake needs — and it keeps the duplicate guard testable without an
// emulator, which matters because the guard's failure mode (two switches on one
// site) is silent: darkSites() stops reporting the site dark and nothing
// anywhere says why.
vi.mock('../../../shared/data/client.js', () => ({
  collection: (_db, ...parts) => ({ __col: parts.join('/') }),
  doc: (colRef, id) => ({ __path: `${colRef.__col}/${id ?? `auto${autoId++}`}`, __auto: id == null }),
  addDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  onSnapshot: vi.fn(),
  query: (...parts) => ({ __query: parts }),
  orderBy: (f) => ({ __orderBy: f }),
  limit: (n) => ({ __limit: n }),
  serverTimestamp: () => '__ts',
  writeBatch: () => makeBatch(),
  getDocs: (...args) => getDocsMock(...args),
}))
vi.mock('../../../shared/firebase', () => ({ db: {} }))
vi.mock('../../../shared/sessionEnd', () => ({ isSessionEnd: () => false }))
vi.mock('../../../shared/org/orgData', () => ({
  logAudit: (...args) => audits.push(args),
  COLLECTION_READ_CAP: 5000,
}))

let autoId = 0
let audits = []
let committed = []
let getDocsMock = vi.fn()

/** A batch that records its writes into `committed` only once commit() runs. */
function makeBatch() {
  const pending = []
  return {
    set(ref, data) { pending.push({ path: ref.__path, auto: ref.__auto, data }) },
    async commit() { committed.push(...pending) },
  }
}

/** getDocs answering with a fixed Meraki collection. */
const collectionOf = (rows) => vi.fn(async () => ({ docs: rows.map((r) => ({ id: r.id, data: () => r })) }))

const { provisionSiteMerakis, provisionMerakisForNewSites } = await import('./firestore')

const site = (o = {}) => ({ id: 's1', name: 'Hosur', ...o })
const stored = (o = {}) => ({ id: 'site_s1', name: 'MX-Hosur', siteId: 's1', status: 'unknown', ...o })
const paths = () => committed.map((w) => w.path)

beforeEach(() => {
  autoId = 0
  audits = []
  committed = []
  getDocsMock = collectionOf([])
})

describe('provisionSiteMerakis', () => {
  it('creates one document per uncovered site, addressed by that site', async () => {
    const n = await provisionSiteMerakis([site(), site({ id: 's2', name: 'Pune' })], [], {})
    expect(n).toBe(2)
    expect(paths()).toEqual([
      'organizations/org1/cctvMeraki/site_s1',
      'organizations/org1/cctvMeraki/site_s2',
    ])
    expect(committed.every((w) => w.auto === false)).toBe(true)
  })

  // The bug this file was written for. The Inventory button hands over a live
  // listener's snapshot, rendered into the button some time before the click.
  // Trusting it meant a second switch for every site whose record had landed in
  // between — from another manager, another tab, or the site-created hook.
  it('ignores a stale caller list and asks the collection instead', async () => {
    getDocsMock = collectionOf([stored()])
    const n = await provisionSiteMerakis([site()], [], {})
    expect(n).toBe(0)
    expect(committed).toEqual([])
  })

  it('still honours what the caller passes — it can only ADD coverage', async () => {
    // Nothing in Firestore yet, but the caller knows of a record for s2.
    const n = await provisionSiteMerakis(
      [site(), site({ id: 's2', name: 'Pune' })],
      [{ id: 'm9', siteId: 's2' }],
      {}
    )
    expect(n).toBe(1)
    expect(paths()).toEqual(['organizations/org1/cctvMeraki/site_s1'])
  })

  // Two runs that genuinely overlap both read an empty collection, so neither
  // can see the other. Addressing the document by site is what makes the second
  // write land on the first one's document instead of beside it.
  it('converges on one document when two runs race', async () => {
    await Promise.all([
      provisionSiteMerakis([site()], [], {}),
      provisionSiteMerakis([site()], [], {}),
    ])
    expect(paths()).toEqual([
      'organizations/org1/cctvMeraki/site_s1',
      'organizations/org1/cctvMeraki/site_s1',
    ])
    expect(new Set(paths()).size).toBe(1)
  })

  it('does not write twice for a site handed in twice in one call', async () => {
    const n = await provisionSiteMerakis([site(), site()], [], {})
    expect(n).toBe(1)
    expect(paths()).toEqual(['organizations/org1/cctvMeraki/site_s1'])
  })

  // The siteId check and the doc-id check fail differently, which is why both
  // are there: a record whose siteId was cleared by hand reads as an uncovered
  // site, and writing it would clobber the very record being looked for.
  it('leaves an existing document alone even when its siteId went missing', async () => {
    getDocsMock = collectionOf([stored({ siteId: '' })])
    const n = await provisionSiteMerakis([site()], [], {})
    expect(n).toBe(0)
    expect(committed).toEqual([])
  })

  // An unaddressable site still needs its switch — a site with no Meraki is the
  // failure the module exists to prevent, and is worse than one without the
  // extra guard.
  it('falls back to an auto-id rather than skipping an unaddressable site', async () => {
    const n = await provisionSiteMerakis([{ id: 'a/b', name: 'Odd' }], [], {})
    expect(n).toBe(1)
    expect(committed[0].auto).toBe(true)
  })

  it('writes the standard payload, unverified rather than green', async () => {
    await provisionSiteMerakis([site()], [], {})
    expect(committed[0].data).toMatchObject({
      name: 'MX-Hosur', siteId: 's1', siteName: 'Hosur', status: 'unknown',
    })
  })

  it('audits what it actually wrote, not what it considered', async () => {
    getDocsMock = collectionOf([stored()])
    await provisionSiteMerakis([site(), site({ id: 's2', name: 'Pune' })], [], {})
    expect(audits).toHaveLength(1)
    expect(audits[0][3].summary).toMatch(/for 1 site\(s\)/)
  })

  it('logs nothing and reads nothing when there are no sites', async () => {
    expect(await provisionSiteMerakis([], [], {})).toBe(0)
    expect(await provisionSiteMerakis([site()], [], {})).toBe(0)
    expect(getDocsMock).not.toHaveBeenCalled()
    expect(audits).toEqual([])
  })

  it('leaves no audit entry behind when everything was already covered', async () => {
    getDocsMock = collectionOf([stored()])
    await provisionSiteMerakis([site()], [], {})
    expect(audits).toEqual([])
  })

  // Firestore rejects a batch over 500 writes.
  it('chunks a large estate under the batch cap', async () => {
    const sites = Array.from({ length: 900 }, (_, i) => ({ id: `s${i}`, name: `Site ${i}` }))
    expect(await provisionSiteMerakis(sites, [], {})).toBe(900)
    expect(new Set(paths()).size).toBe(900)
  })
})

describe('provisionMerakisForNewSites', () => {
  it('provisions a newly created site', async () => {
    expect(await provisionMerakisForNewSites([site()], {})).toBe(1)
    expect(paths()).toEqual(['organizations/org1/cctvMeraki/site_s1'])
  })

  // A hook fired twice, or a retried write, must not double up.
  it('is a no-op when the site already has one', async () => {
    getDocsMock = collectionOf([stored()])
    expect(await provisionMerakisForNewSites([site()], {})).toBe(0)
    expect(committed).toEqual([])
  })

  it('does nothing without an org or sites', async () => {
    expect(await provisionMerakisForNewSites([site()], {})).toBe(0)
    expect(await provisionMerakisForNewSites([], {})).toBe(0)
    expect(getDocsMock).not.toHaveBeenCalled()
  })
})
