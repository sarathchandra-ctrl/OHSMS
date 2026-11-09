// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'

const backfillDocumentVisibility = vi.fn()
const backfillClaims = vi.fn()
const clearOrphanedDefectLocks = vi.fn()
const backfillProcedureMirrors = vi.fn()
const linkEquipmentSites = vi.fn()
const seedInjuryRecords = vi.fn()
const stripIncidentMedicalDetail = vi.fn()
const confineMedicalRecords = vi.fn()
const exportSubjectData = vi.fn()

vi.mock('../../shared/functions', () => ({
  backfillDocumentVisibility: (...a) => backfillDocumentVisibility(...a),
  backfillClaims: (...a) => backfillClaims(...a),
  clearOrphanedDefectLocks: (...a) => clearOrphanedDefectLocks(...a),
  linkEquipmentSites: (...a) => linkEquipmentSites(...a),
  seedInjuryRecords: (...a) => seedInjuryRecords(...a),
  stripIncidentMedicalDetail: (...a) => stripIncidentMedicalDetail(...a),
  confineMedicalRecords: (...a) => confineMedicalRecords(...a),
  exportSubjectData: (...a) => exportSubjectData(...a),
}))
vi.mock('../../shared/crypto/keyring', () => ({ sealingEnabled: false }))
// The procedure-mirror job runs in the browser rather than as a callable, so
// unlike its neighbours it needs the caller's org and reaches the LOTO service
// directly. Both are mocked here — importing the real service would stand up
// Firebase, and this page is rendered without a provider.
vi.mock('../../shared/auth/AuthContext', () => ({ useAuth: () => ({  }) }))
vi.mock('../../modules/loto/services/procedures', () => ({
  backfillProcedureMirrors: (...a) => backfillProcedureMirrors(...a),
}))
vi.mock('../../shared/monitoring', () => ({ reportError: vi.fn() }))
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

const { default: Maintenance } = await import('./Maintenance')

const DRY = {
  total: 4, alreadyStamped: 1, wouldWrite: 3, written: 0,
  orgWide: 2, siteScoped: 1, titles: ['Lockout/Tagout Policy'],
}

// A dry run with nothing needing a person: three records to link, no name
// matching two sites and no record already filed somewhere else.
const LINKS = {
  equipment: 12, sites: 8, alreadyLinked: 9, deleted: 0,
  wouldWrite: 3, written: 0,
  ambiguous: [], ambiguousTotal: 0,
  conflicting: [], conflictingTotal: 0,
  unmatchedNames: [], unmatchedNameTotal: 0, unmatchedTotal: 0,
  noName: 0,
  sample: [{ collection: 'extinguishers', id: 'e1', matchedName: 'Cult Gym Ameerpet' }],
}

// Step 1 with the work already done: nothing left to write into /injuries, so
// step 2 is allowed to run.
const SEEDED = {
  incidents: 6, injuries: 4, wouldWrite: 0, written: 0,
  created: 0, completed: 0, seeded: 0, alreadyHeld: 18, alreadyComplete: 4,
  blocked: [], blockedTotal: 0, blockedFields: 0,
  orphanInjuries: [], orphanInjuryTotal: 0, sample: [],
}

// Step 2 with every field proved to be in the injury record already.
const STRIP = {
  incidents: 6, injuries: 4, alreadyClean: 3, stillExposed: 0,
  wouldWrite: 3, written: 0, confined: 12, emptied: 2,
  blocked: [], blockedTotal: 0, blockedFields: 0, sample: [],
}

// Step 3: two medical records still filed with the incident photos, both
// attributable, both with their file still under the member-readable prefix.
const RECORDS = {
  incidents: 6, records: 2, photos: 9,
  moved: 0, wouldMove: 2, filesToMove: 2, filesMoved: 0,
  inlineRecords: 0, urlsDropped: 2, underDeletedInjury: 0, remaining: 0,
  blocked: [], blockedTotal: 0, blockedReasons: {},
  failed: [], failedTotal: 0, tokensLeft: 0,
  prefix: 'medical-records', sample: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  seedInjuryRecords.mockResolvedValue(SEEDED)
  stripIncidentMedicalDetail.mockResolvedValue(STRIP)
  confineMedicalRecords.mockResolvedValue(RECORDS)
  linkEquipmentSites.mockResolvedValue(LINKS)
  backfillDocumentVisibility.mockResolvedValue(DRY)
  clearOrphanedDefectLocks.mockResolvedValue({ total: 0, kept: 0, wouldRemove: 0, removed: 0, ids: [] })
  backfillProcedureMirrors.mockResolvedValue({ total: 3, present: 1, missing: 2, ids: ['p1', 'p2'], written: 0 })
  backfillClaims.mockResolvedValue({
    total: 5, updated: 4, stamped: 4, alreadyCorrect: 0, notApproved: 1, noAuthUser: 0, failed: [],
  })
})

// Several jobs carry a button of the same name, so every query is scoped to
// the region it belongs to.
const card = (name) => within(screen.getByRole('region', { name }))
const docs = () => card(/Stamp document visibility/)
const btn = (name) => docs().getByRole('button', { name })

describe('Maintenance', () => {
  it('offers both jobs', () => {
    render(<Maintenance />)
    expect(screen.getByRole('heading', { name: /Stamp document visibility/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /sign-in token/ })).toBeTruthy()
  })

  // The write touches every document in the library, so it stays out of reach
  // until someone has actually looked at what it would do.
  it('will not stamp until you have checked', () => {
    render(<Maintenance />)
    expect(btn(/Stamp them/).disabled).toBe(true)
  })

  it('checks without writing, and reports what it found', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(btn(/Check first/)))

    await waitFor(() => expect(backfillDocumentVisibility).toHaveBeenCalledWith({ dryRun: true }))
    expect(screen.getByText(/3 to stamp/)).toBeTruthy()
    expect(screen.getByText(/Lockout\/Tagout Policy/)).toBeTruthy()
    expect(btn(/Stamp them/).disabled).toBe(false)
  })

  it('writes only on the second, explicit click', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(btn(/Check first/)))
    await waitFor(() => expect(btn(/Stamp them/).disabled).toBe(false))

    backfillDocumentVisibility.mockResolvedValue({ ...DRY, written: 3, wouldWrite: 3 })
    await act(async () => fireEvent.click(btn(/Stamp them/)))

    await waitFor(() => expect(backfillDocumentVisibility).toHaveBeenLastCalledWith({ dryRun: false }))
  })

  // Nothing to do is a success, not an invitation to press the dangerous button.
  it('leaves the write disabled when there is nothing to stamp', async () => {
    backfillDocumentVisibility.mockResolvedValue({ ...DRY, wouldWrite: 0, orgWide: 0, siteScoped: 0, titles: [] })
    render(<Maintenance />)
    await act(async () => fireEvent.click(btn(/Check first/)))

    await waitFor(() => expect(screen.getByText(/0 to stamp/)).toBeTruthy())
    expect(btn(/Stamp them/).disabled).toBe(true)
  })

  it('runs the claims job and reports the counts', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(card(/sign-in token/).getByRole('button', { name: /Update tokens/ })))

    await waitFor(() => expect(backfillClaims).toHaveBeenCalled())
    expect(screen.getByText(/4 updated/)).toBeTruthy()
  })

  it('surfaces a failure instead of looking like it worked', async () => {
    backfillDocumentVisibility.mockRejectedValue(new Error('permission-denied'))
    const toast = (await import('react-hot-toast')).default
    render(<Maintenance />)
    await act(async () => fireEvent.click(btn(/Check first/)))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('permission-denied'))
    expect(btn(/Stamp them/).disabled).toBe(true)
  })
})

// The LOTO procedure QR opens a public read-only page, which only exists for
// procedures that have a published mirror. Procedures written before that
// feature have none until something changes them, so this job publishes the
// rest — and like its neighbours it must not write until someone has looked.
describe('publishing procedure QR pages', () => {
  const job = () => within(screen.getByRole('region', { name: /Publish procedure QR pages/ }))

  it('will not publish until you have checked', () => {
    render(<Maintenance />)
    expect(job().getByRole('button', { name: /Publish them/ }).disabled).toBe(true)
  })

  it('reports how many printed codes lead nowhere, without writing', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() =>
      expect(backfillProcedureMirrors).toHaveBeenCalledWith('org-1', { dryRun: true }))
    expect(screen.getByText(/2 whose printed code leads nowhere/)).toBeTruthy()
    expect(job().getByRole('button', { name: /Publish them/ }).disabled).toBe(false)
  })

  it('writes only on the second, explicit click', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    backfillProcedureMirrors.mockResolvedValue({ total: 3, present: 3, missing: 0, ids: [], written: 3 })
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Publish them/ })))

    expect(backfillProcedureMirrors).toHaveBeenCalledWith('org-1', { dryRun: false })
    await waitFor(() => expect(job().getByRole('button', { name: /Published/ })).toBeTruthy())
  })

  it('stays disabled when every procedure is already published', async () => {
    backfillProcedureMirrors.mockResolvedValue({ total: 3, present: 3, missing: 0, ids: [], written: 0 })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(job().getByRole('button', { name: /Publish them/ }).disabled).toBe(true))
  })
})

// Equipment imported before sites were records carries a centre name and no
// site link. Matching the two up is the easy part; the part worth a test is
// what happens when the match is not certain, because filing an extinguisher
// at a site it is not at is the exact failure this job exists to fix.
describe('linking equipment to its site', () => {
  const job = () => within(screen.getByRole('region', { name: /Link equipment to its site/ }))
  const link = () => job().getByRole('button', { name: /Link them|Linked/ })

  it('will not link until you have checked', () => {
    render(<Maintenance />)
    expect(link().disabled).toBe(true)
  })

  it('reports what it would link, without writing', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(linkEquipmentSites).toHaveBeenCalledWith({ dryRun: true }))
    expect(screen.getByText(/3 to link/)).toBeTruthy()
    expect(link().disabled).toBe(false)
  })

  it('writes only on the second, explicit click', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(link().disabled).toBe(false))

    linkEquipmentSites.mockResolvedValue({ ...LINKS, written: 3 })
    await act(async () => fireEvent.click(link()))

    await waitFor(() => expect(linkEquipmentSites).toHaveBeenLastCalledWith({ dryRun: false }))
  })

  // A centre name matching two sites cannot be resolved by any rule — one of
  // the two would win on document order. The job never writes those rows, so
  // this gate is not what makes the run safe; it is what makes a person look.
  it('refuses to link anything while a name matches two sites', async () => {
    linkEquipmentSites.mockResolvedValue({
      ...LINKS,
      ambiguousTotal: 1,
      ambiguous: [{
        collection: 'extinguishers',
        id: 'e9',
        centerName: 'Raptor Fitness Addagutta',
        siteIds: ['s7', 's9'],
        siteNames: ['Raptor Fitness (Addagutta)', 'Raptor Fitness Addagutta'],
        how: 'alnum',
      }],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(screen.getByText(/1 whose name matches more than one site/)).toBeTruthy())
    // Both candidates named: the count says stop, the names say where to look.
    expect(screen.getByText(/Raptor Fitness \(Addagutta\)\s+\/\s+Raptor Fitness Addagutta/)).toBeTruthy()
    expect(link().disabled).toBe(true)
  })

  // Somebody may have linked this by hand, correctly, and the printed name is
  // the stale half. The job cannot tell which half is stale, so it does not get
  // to pick — and it must not quietly move the record either.
  it('refuses to link anything while a record disagrees with its existing site', async () => {
    linkEquipmentSites.mockResolvedValue({
      ...LINKS,
      conflictingTotal: 1,
      conflicting: [{
        collection: 'aeds',
        id: 'a4',
        centerName: 'Cult Ameerpet',
        currentSiteId: 's2',
        resolvedSiteId: 's1',
        resolvedName: 'Cult Gym Ameerpet',
        how: 'core',
      }],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(screen.getByText(/1 already linked to a different site/)).toBeTruthy())
    expect(screen.getByText(/linked to s2, name says Cult Gym Ameerpet/)).toBeTruthy()
    expect(link().disabled).toBe(true)
  })

  // Unmatched is not a blocker — nothing can be written for those records
  // either way, and a name nobody has spelled consistently would otherwise stop
  // the whole estate from being linked.
  it('still links the records it is sure of when others match nothing', async () => {
    linkEquipmentSites.mockResolvedValue({
      ...LINKS,
      unmatchedTotal: 2,
      unmatchedNameTotal: 1,
      unmatchedNames: ['Strak Fitness Studio'],
      noName: 1,
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(screen.getByText(/Strak Fitness Studio/)).toBeTruthy())
    expect(screen.getByText(/1 carry no centre name/)).toBeTruthy()
    expect(link().disabled).toBe(false)
  })

  it('leaves the write disabled when there is nothing to link', async () => {
    linkEquipmentSites.mockResolvedValue({ ...LINKS, alreadyLinked: 12, wouldWrite: 0, sample: [] })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(screen.getByText(/0 to link/)).toBeTruthy())
    expect(link().disabled).toBe(true)
  })
})

// Two steps that have to run in order. Step 2 removes medical detail from
// incidents and it is the ONLY copy afterwards, so it refuses any field it
// cannot first find in the injury record. Step 1 is what puts it there. Running
// step 2 first does not corrupt anything — it just reports the same blocked rows
// forever — but the screen has to make the order obvious, because the failure it
// is guarding against is deleting somebody's injury record.
describe('the medical detail migration, in two steps', () => {
  const seedJob = () => within(screen.getByRole('region', { name: /Step 1/ }))
  const stripJob = () => within(screen.getByRole('region', { name: /Step 2/ }))
  const fillBtn = () => seedJob().getByRole('button', { name: /Fill them in|Filled in/ })
  const cleanBtn = () => stripJob().getByRole('button', { name: /Clean them|Cleaned/ })

  it('shows the two steps in order', () => {
    render(<Maintenance />)
    expect(screen.getByRole('heading', { name: /Step 1 — Fill in the injury records/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Step 2 — Clean medical detail off incidents/ })).toBeTruthy()
  })

  // Never having looked and having looked and found nothing are different
  // states, and only one of them is evidence that cleaning is safe.
  it('will not let you even check step 2 until step 1 has been run', () => {
    render(<Maintenance />)
    expect(stripJob().getByRole('button', { name: /Check first/ }).disabled).toBe(true)
    expect(cleanBtn().disabled).toBe(true)
    expect(screen.getByText(/Run step 1 first/)).toBeTruthy()
  })

  it('keeps step 2 shut while step 1 still has records to write', async () => {
    seedInjuryRecords.mockResolvedValue({ ...SEEDED, wouldWrite: 2, created: 1, completed: 1, seeded: 7 })
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(screen.getByText(/1 to create, 1 to complete/)).toBeTruthy())
    expect(stripJob().getByRole('button', { name: /Check first/ }).disabled).toBe(true)
    expect(screen.getByText(/Step 1 still has 2 injury records to write/)).toBeTruthy()
  })

  it('opens step 2 once step 1 reports nothing left to write', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(seedInjuryRecords).toHaveBeenCalledWith({ dryRun: true }))
    expect(stripJob().getByRole('button', { name: /Check first/ }).disabled).toBe(false)
    // Still gated on its own look, like every other job on this page.
    expect(cleanBtn().disabled).toBe(true)

    await act(async () => fireEvent.click(stripJob().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(cleanBtn().disabled).toBe(false))
  })

  it('reports without writing, and only writes on the second, explicit click', async () => {
    seedInjuryRecords.mockResolvedValue({ ...SEEDED, wouldWrite: 2, created: 2, seeded: 7 })
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(fillBtn().disabled).toBe(false))

    seedInjuryRecords.mockResolvedValue({ ...SEEDED, written: 2 })
    await act(async () => fireEvent.click(fillBtn()))
    await waitFor(() => expect(seedInjuryRecords).toHaveBeenLastCalledWith({ dryRun: false }))
  })

  // A step 2 preview taken before a seed describes a world that no longer
  // exists — it was counting rows the seed has since made strippable.
  it('makes you re-check step 2 after step 1 writes', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))
    await act(async () => fireEvent.click(stripJob().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(cleanBtn().disabled).toBe(false))

    seedInjuryRecords.mockResolvedValue({ ...SEEDED, wouldWrite: 1, created: 1, seeded: 3 })
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(cleanBtn().disabled).toBe(true))
  })

  it('leaves step 1 disabled when every injury record already holds its detail', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(screen.getByText(/0 injury records to write/)).toBeTruthy())
    expect(fillBtn().disabled).toBe(true)
  })

  // The reason codes are the entire value of the report and none of them used
  // to reach the screen: the card printed `blockedFields.join(', ')` and
  // blockedFields is a COUNT, so the line rendered nothing at all. A run that
  // found a blocked row looked exactly like a run that found nothing.
  it('says in plain words why a row could not be seeded', async () => {
    seedInjuryRecords.mockResolvedValue({
      ...SEEDED,
      blockedTotal: 3,
      blocked: [
        { incidentId: 'i1', refNo: 'IRA-2026-0007', personId: '', personName: 'Ravi Kumar', reason: 'sign-in-id-only', fields: ['bodyParts', 'injuryType'] },
        { incidentId: 'i2', refNo: 'IRA-2026-0011', personId: 'EMP-2', personName: 'Sam', reason: 'differs-in-injury', fields: ['medication'] },
        { incidentId: 'i3', refNo: 'IRA-2026-0012', personId: 'EMP-3', personName: 'Ana', reason: 'injury-record-verified', fields: ['medication'] },
      ],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(screen.getByText(/3 rows need a person, not a migration/)).toBeTruthy())
    expect(screen.getByText(/identified only by sign-in id/)).toBeTruthy()
    expect(screen.getByText(/only a person can say which is right/)).toBeTruthy()
    expect(screen.getByText(/verified and locked/)).toBeTruthy()
  })

  it('never names the medical detail it declined to move', async () => {
    seedInjuryRecords.mockResolvedValue({
      ...SEEDED,
      blockedTotal: 1,
      blocked: [{ incidentId: 'i1', refNo: 'IRA-2026-0007', personId: '', personName: 'Ravi Kumar', reason: 'no-person-id', fields: ['bodyParts', 'injuryType'] }],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(seedJob().getByText(/1 × the row names no person/)).toBeTruthy())
    expect(screen.queryByText(/bodyParts/)).toBe(null)
  })

  it('reports the injury records that belong to nobody on their incident', async () => {
    seedInjuryRecords.mockResolvedValue({
      ...SEEDED,
      orphanInjuryTotal: 1,
      orphanInjuries: [{ injuryId: 'i1__WIZ-7', incidentId: 'i1', personId: 'WIZ-7' }],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(screen.getByText(/belongs to nobody named on their incident/)).toBeTruthy())
  })

  it('spells out what step 2 still refuses to clean', async () => {
    stripIncidentMedicalDetail.mockResolvedValue({
      ...STRIP,
      stillExposed: 1,
      blockedTotal: 1,
      blocked: [{ incidentId: 'i1', refNo: 'IRA-2026-0007', personId: '', personName: 'Ravi Kumar', reason: 'no-person-id', fields: ['injuryType'] }],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))
    await act(async () => fireEvent.click(stripJob().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(stripJob().getByText(/1 cannot be cleaned/)).toBeTruthy())
    expect(stripJob().getByText(/1 × the row names no person/)).toBeTruthy()
  })

  it('surfaces a failure instead of looking like it worked', async () => {
    seedInjuryRecords.mockRejectedValue(new Error('permission-denied'))
    const toast = (await import('react-hot-toast')).default
    render(<Maintenance />)
    await act(async () => fireEvent.click(seedJob().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('permission-denied'))
    expect(fillBtn().disabled).toBe(true)
    expect(cleanBtn().disabled).toBe(true)
  })
})

// Step 3 moves the attached DOCUMENTS. Steps 1 and 2 move fields; a GP letter
// sitting in the incident photo album is the same exposure with a filename on
// it, and unlike a field it also carries a link that works without an account.
describe('moving the medical record files', () => {
  const job = () => within(screen.getByRole('region', { name: /Move the medical record files/ }))
  const moveBtn = () => job().getByRole('button', { name: /Move them|Moved/ })

  it('will not move anything until you have checked', () => {
    render(<Maintenance />)
    expect(moveBtn().disabled).toBe(true)
  })

  it('reports what is still filed with the photos, without moving it', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(confineMedicalRecords).toHaveBeenCalledWith({ dryRun: true }))
    expect(job().getByText(/2 medical records filed with the incident photos/)).toBeTruthy()
    expect(job().getByText(/2 to move/)).toBeTruthy()
    expect(moveBtn().disabled).toBe(false)
  })

  // The file is the other half. A pointer only managers can read is worth
  // nothing while the bytes sit under a prefix the whole tenant can read.
  it('says how many files are still readable by the whole organization', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    await waitFor(() =>
      expect(job().getByText(/2 files still stored where everyone in this organization can read them/)).toBeTruthy())
  })

  // The one thing an admin must not misread as solved by pressing the button.
  it('says plainly what moving a file does and does not do to its download link', () => {
    render(<Maintenance />)
    expect(job().getByText(/that link stops working/)).toBeTruthy()
    expect(job().getByText(/already been used/)).toBeTruthy()
    expect(job().getByText(/download token is rotated/)).toBeTruthy()
  })

  it('moves only on the second, explicit click', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    await waitFor(() => expect(moveBtn().disabled).toBe(false))

    confineMedicalRecords.mockResolvedValue({ ...RECORDS, moved: 2, filesMoved: 2 })
    await act(async () => fireEvent.click(moveBtn()))

    await waitFor(() => expect(confineMedicalRecords).toHaveBeenLastCalledWith({ dryRun: false }))
    await waitFor(() => expect(job().getByRole('button', { name: /Moved/ })).toBeTruthy())
  })

  // Blocked rows are reported and never gate the run: every record left behind
  // stays listable by the whole organization, so refusing to move the rest to
  // protect nothing would keep medical documents exposed.
  it('still moves what it can when a record cannot be attributed', async () => {
    confineMedicalRecords.mockResolvedValue({
      ...RECORDS,
      wouldMove: 1,
      blockedTotal: 1,
      blockedReasons: { 'several-people': 1 },
      blocked: [{ incidentId: 'inc9', refNo: 'INC-009', photoId: 'p3', reason: 'several-people' }],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(job().getByText(/1 cannot be moved without guessing/)).toBeTruthy())
    expect(job().getByText(/1 × more than one person was injured/)).toBeTruthy()
    expect(moveBtn().disabled).toBe(false)
  })

  // A capped run is a finished run, not a failed one — but it must not look
  // done, or the second run never happens and the rest stay exposed.
  it('asks for another run when more are left than one run may move', async () => {
    confineMedicalRecords.mockResolvedValue({ ...RECORDS, moved: 200, wouldMove: 200, remaining: 40 })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))
    await act(async () => fireEvent.click(moveBtn()))

    await waitFor(() => expect(job().getByText(/40 more than one run may move/)).toBeTruthy())
    expect(job().queryByRole('button', { name: /^Moved$/ })).toBe(null)
  })

  // Left exactly where it was, with its pointer and its file intact — the whole
  // point of writing and verifying before deleting.
  it('reports a record it could not move rather than counting it done', async () => {
    confineMedicalRecords.mockResolvedValue({
      ...RECORDS,
      moved: 1,
      failedTotal: 1,
      failed: [{ incidentId: 'inc4', refNo: 'INC-004', photoId: 'p7', error: 'the moved record did not read back intact' }],
    })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(job().getByText(/1 could not be moved and was left exactly where it was/)).toBeTruthy())
  })

  it('leaves the move disabled when nothing is filed with the photos', async () => {
    confineMedicalRecords.mockResolvedValue({ ...RECORDS, records: 0, wouldMove: 0, filesToMove: 0, urlsDropped: 0 })
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(job().getByText(/0 to move/)).toBeTruthy())
    expect(moveBtn().disabled).toBe(true)
  })

  it('surfaces a failure instead of looking like it worked', async () => {
    confineMedicalRecords.mockRejectedValue(new Error('permission-denied'))
    const toast = (await import('react-hot-toast')).default
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Check first/ })))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('permission-denied'))
    expect(moveBtn().disabled).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Subject access.
//
// The thing worth testing here is not that it fetches — it is that it refuses
// to present the half it CAN fetch as the whole answer. A person's name is also
// free text inside array objects, which Firestore cannot query, so an export
// that showed only the keyed records would look authoritative and be incomplete.
// That is a failed response to a legal request, not a partial one.
// ─────────────────────────────────────────────────────────────────────────────
describe('subject access request', () => {
  const job = () => within(screen.getByRole('region', { name: /Subject access request/ }))

  const RESULT = {
    subject: { uid: 'u1', personId: null },
    records: { users: [{ id: 'u1' }], injuries: [{ id: 'a' }, { id: 'b' }], auditLogs: [] },
    mentions: [
      { path: 'consultations', fields: ['attendees[].name'] },
      { path: 'incidents', fields: ['affectedPersonnel[].name'] },
    ],
    scan: { feasible: true, note: 'Fields are stored in the clear.' },
    erasure: {
      refused: [{ path: 'injuries', why: 'Statutory retention; it is the person’s own evidence.' }],
      anonymise: [{ path: 'users', why: 'Removing it orphans authored records.' }],
      erasable: [{ path: 'erpContacts', why: 'A contact list entry.' }],
    },
    problems: [],
  }

  beforeEach(() => exportSubjectData.mockReset())

  it('will not run without a person to look up', async () => {
    render(<Maintenance />)
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Gather/ })))
    expect(exportSubjectData).not.toHaveBeenCalled()
  })

  it('counts what it found by key, per collection', async () => {
    exportSubjectData.mockResolvedValue(RESULT)
    render(<Maintenance />)
    fireEvent.change(job().getByLabelText(/User id/), { target: { value: 'u1' } })
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Gather/ })))
    await waitFor(() => expect(job().getByText(/injuries: 2/)).toBeTruthy())
    expect(job().getByText(/users: 1/)).toBeTruthy()
  })

  // The whole point. These are places to look, not results, and they have to
  // reach the screen or the export overstates itself.
  it('names the places a query cannot reach, rather than omitting them', async () => {
    exportSubjectData.mockResolvedValue(RESULT)
    render(<Maintenance />)
    fireEvent.change(job().getByLabelText(/User id/), { target: { value: 'u1' } })
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Gather/ })))
    await waitFor(() => expect(job().getByText(/attendees\[\]\.name/)).toBeTruthy())
    expect(job().getByText(/affectedPersonnel\[\]\.name/)).toBeTruthy()
  })

  // A refusal is part of the answer, and the reason is what gets sent back to
  // the person asking.
  it('shows what cannot lawfully be erased, with the reason', async () => {
    exportSubjectData.mockResolvedValue(RESULT)
    render(<Maintenance />)
    fireEvent.change(job().getByLabelText(/User id/), { target: { value: 'u1' } })
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Gather/ })))
    await waitFor(() => expect(job().getByText(/must be RETAINED by law/)).toBeTruthy())
    expect(job().getByText(/own evidence/)).toBeTruthy()
  })

  // Once encryption is on, a scan of those fields reads ciphertext and finds
  // nothing — which looks exactly like a person who is not mentioned. Silence
  // here would be a wrong answer to a legal request.
  it('warns when the unsearchable half could not have been searched at all', async () => {
    exportSubjectData.mockResolvedValue({
      ...RESULT,
      scan: { feasible: false, reason: 'encrypted', note: 'Sealed fields would report zero mentions.' },
    })
    render(<Maintenance />)
    fireEvent.change(job().getByLabelText(/User id/), { target: { value: 'u1' } })
    await act(async () => fireEvent.click(job().getByRole('button', { name: /Gather/ })))
    await waitFor(() => expect(job().getByText(/zero mentions/)).toBeTruthy())
  })
})
