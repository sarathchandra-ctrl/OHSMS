import { describe, it, expect, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Parity: the WhatsApp site summary (stack/lib/siteSummary.js) against the
// app's own helpers, over one fixture.
//
// functions/ cannot import src/, so the server carries copies. This is the test
// that keeps them copies: each number is computed here twice — once by the
// server port, once by composing the browser helpers exactly as the screens do
// (Admin → Sites, the Defect Repository, the Action Tracker) — and the two must
// agree for every site. A change to a definition on either side fails here.
//
// Invented data only.
// ─────────────────────────────────────────────────────────────────────────────

// sources.js reaches Firestore and the keyring at import; only its pure
// extract / toNorm / isOverdue are used here.
vi.mock('../../shared/db', () => ({ db: {} }))
vi.mock('../../shared/crypto', () => ({ openSnapshots: () => () => {} }))
vi.mock('../../shared/data/client.js', () => ({ doc: () => ({}), getDoc: vi.fn(), updateDoc: vi.fn() }))
vi.mock('../../shared/org/orgData', () => ({
  subscribeOrgCollection: () => () => {},
  incompleteReadNotice: () => null,
  COLLECTION_READ_CAP: 5000,
}))
vi.mock('../../modules/fire/lib/data', () => ({ releaseDefectLocks: vi.fn() }))

const { siteStats, linkAssets } = await import('./siteStats')
const { resolveSite } = await import('../../modules/fire/lib/siteLink')
const { deriveStatus, isDeleted } = await import('../../modules/fire/lib/extinguisherLogic')
const { derivePhysicalDefectLog } = await import('../../modules/fire/lib/defectReports')
const { deriveExtinguisherDefects } = await import('../../modules/fire/lib/derivedExtDefects')
const { SOURCES, isOverdue, todayISO } = await import('../../modules/actions/lib/sources')
const { summariseSites, istDay: serverIstDay } = await import('../../../stack/lib/siteSummary.js')
const { istDay: appIstDay } = await import('../../shared/lib/dates')

// 12 Oct 2026, noon in Asia/Kolkata. Hydrostatic due dates use that calendar
// on both sides. Action overdue still uses the local calendar day of TODAY,
// which this instant also is in every timezone CI runs.
const NOW = new Date('2026-10-12T06:30:00Z')
const TODAY = new Date(2026, 9, 12)

const sites = [
  {
    id: 's1',
    name: 'Cult Gym Ameerpet',
    code: '0071',
    region: 'South',
    entity: 'Demo',
    firstAidBoxes: 2,
  },
  {
    id: 's2',
    name: 'Cult Koramangala 5th Block',
    code: 'BLR0123',
    region: 'South',
    entity: 'Demo',
    firstAidBoxes: '3',
  },
  { id: 's3', name: 'Fitso Madhapur Pearl', code: 'HYD0300', region: 'North', entity: 'Other' },
  // Override target: equipment says "Madhapur Pearl".
  { id: 's4', name: 'Empty Site', code: 'X1' },
]

const ext = (id, extra) => ({
  id,
  status: 'active',
  dateOfNextHPT: '2028-01-01',
  physicalDefects: [],
  ...extra,
})
const extinguishers = [
  ext('e1', { siteId: 's1', dateOfNextHPT: '2026-10-01' }), // HPT due
  ext('e2', { centerName: 'Cult Ameerpet', physicalDefects: ['pin', 'empty'] }), // resolves to s1
  ext('e3', { centerName: 'cult koramangala 5th block', dateOfNextHPT: '2026-10-12' }), // due today
  ext('e4', {
    siteId: 's2',
    status: 'closed',
    dateOfNextHPT: '2020-01-01',
    physicalDefects: ['empty'],
  }), // closed: no derived
  ext('e5', { centerName: 'Madhapur Pearl', physicalDefects: ['handle'] }), // override → s3
  ext('e6', { siteId: 's1', deletedAt: '2026-09-01', dateOfNextHPT: '2020-01-01' }), // in the bin
  ext('e7', { centerName: 'Nowhere Known' }), // unattributable
  ext('e8', {
    siteId: 's2',
    dateOfNextHPT: '2026-10-13',
    physicalDefects: ['stand', 'over_pressurized'],
  }),
  // Closed against the date it still carries: the overdue count stays, the
  // defect row does not. A later date would put the row back.
  ext('e9', {
    siteId: 's4',
    dateOfNextHPT: '2020-01-01',
    hptClosedFor: '2020-01-01',
  }),
]
const aeds = [
  { id: 'a1', centerName: 'Cult Gym Ameerpet' },
  { id: 'a2', siteId: 's2' },
  { id: 'a3', siteId: 's3', deletedAt: '2026-01-01' },
]
const fas = [{ id: 'f1', siteId: 's3' }]
const reports = [
  { id: 'r1', kind: 'defect', approvalStatus: 'approved', defectType: 'pin', extId: 'e2' },
  { id: 'r2', kind: 'defect', approvalStatus: 'approved', defectType: 'handle', extId: 'e5' },
  { id: 'r3', kind: 'defect', approvalStatus: 'approved', defectType: 'stand', extId: 'e1' }, // resolved since
  { id: 'r4', kind: 'defect', approvalStatus: 'pending', defectType: 'stand', extId: 'e8' }, // not approved
  { id: 'r5', kind: 'defect', approvalStatus: 'approved', defectType: 'stand', extId: 'e8' },
  { id: 'r6', kind: 'asset_defect', assetKind: 'aed', assetRefId: 'a1', approvalStatus: 'pending' },
  {
    id: 'r7',
    kind: 'asset_defect',
    assetKind: 'aed',
    assetRefId: 'a2',
    approvalStatus: 'approved',
  },
  { id: 'r8', kind: 'asset_defect', assetKind: 'fas', assetRefId: 'f1', approvalStatus: 'pending' },
  { id: 'r9', kind: 'asset_defect', assetKind: 'aed', assetRefId: 'a3', approvalStatus: 'pending' }, // binned asset
  {
    id: 'r10',
    kind: 'asset_defect',
    assetKind: 'fas',
    assetRefId: 'f1',
    approvalStatus: 'pending',
    deletedAt: 'x',
  },
]
const incidents = [
  {
    id: 'i1',
    siteId: 's1',
    lifecycle: 'closed',
    incidentDate: '2026-08-01',
    capa: [
      { id: 'c1', status: 'open', dueDate: '2026-10-01' },
      { id: 'c2', status: 'closed' },
    ],
  },
  {
    id: 'i2',
    location: 'Gym floor, Cult Koramangala 5th Block',
    lifecycle: 'capa',
    incidentDate: '2026-01-05',
    capa: [{ id: 'c3', status: 'in_progress', dueDate: '2026-12-01' }, { status: 'open' }],
  },
  { id: 'i3', siteId: 's1', lifecycle: 'reporting', incidentDate: '2026-10-11', capa: [] },
  { id: 'i4', siteId: 's1', deletedAt: '2026-10-01', capa: [{ id: 'c4', status: 'open' }] },
]
const mockDrills = [
  {
    id: 'd1',
    centerName: 'Cult Ameerpet',
    capa: [
      { status: 'Open', due: '2026-10-11' },
      { status: 'Closed', due: '2026-01-01' },
    ],
  },
  { id: 'd2', siteId: 's3', capa: [{ status: 'In Progress' }] },
]
const inspectionRecords = [
  {
    id: 'n1',
    siteName: 'Cult Koramangala 5th Block',
    responses: {
      q1: { answer: 'Fail', actionDue: '2026-10-10' },
      q2: { answer: 'Pass' },
      q3: { answer: 'Fail', actionStatus: 'closed' },
    },
  },
  { id: 'n2', siteId: 's1', responses: { q1: { answer: 'Fail', actionStatus: 'in_progress' } } },
]
const auditFindings = [
  {
    id: 'af1',
    taskDetails: { siteId: 's3' },
    findings: [
      { id: 'f1', status: 'Reported', auditeeDueDate: '2026-09-30' },
      { id: 'f2', status: 'Closed' },
      { status: 'Reported' },
    ],
  },
]

// ── The app's numbers, composed as the screens compose them ─────────────────
function appNumbers(site) {
  const links = linkAssets([...extinguishers, ...aeds, ...fas], sites)
  const onSite = (rec) => siteStats(site, { extinguishers: [rec], links }).extinguishers === 1
  const stats = siteStats(site, { extinguishers, aeds, fas, incidents, links })

  // Defect Repository rows (DefectRepository.jsx + FleetContext pendingReports)
  const active = extinguishers.filter((e) => !isDeleted(e))
  const byId = new Map(active.map((e) => [e.id, e]))
  const physicalOpen = derivePhysicalDefectLog(reports, active).open
  const seen = new Set(physicalOpen.map((r) => `${r.extId}:${r.defectType}`))
  const derived = deriveExtinguisherDefects(active, seen, NOW)
  const deletedAed = new Set(aeds.filter(isDeleted).map((a) => a.id))
  const deletedFas = new Set(fas.filter(isDeleted).map((a) => a.id))
  const pending = reports.filter((r) => {
    if (r.approvalStatus !== 'pending' || r.deletedAt) return false
    if (r.kind === 'asset_defect' && r.assetKind === 'aed' && deletedAed.has(r.assetRefId))
      return false
    if (r.kind === 'asset_defect' && r.assetKind === 'fas' && deletedFas.has(r.assetRefId))
      return false
    return true
  })
  const extRows = [...physicalOpen, ...derived].filter((r) => onSite(byId.get(r.extId)))
  const assetRows = pending
    .filter((r) => r.kind === 'asset_defect')
    .map((r) => ({
      r,
      a: (r.assetKind === 'fas' ? fas : aeds).find((x) => x.id === r.assetRefId && !isDeleted(x)),
    }))
    .filter(({ a }) => a && onSite(a))

  // Action Tracker (sources.js), site-attributable sources only.
  const docsFor = {
    incidents,
    drills: mockDrills,
    inspections: inspectionRecords,
    audit: auditFindings,
  }
  const items = []
  for (const src of SOURCES.filter((s) => s.key in docsFor)) {
    for (const d of docsFor[src.key].filter((x) => !x.deletedAt)) {
      for (const a of src.extract(d)) {
        if (a.actionId === undefined || a.actionId === null) continue
        const norm = src.toNorm(a.native)
        const siteId = d.siteId || d.taskDetails?.siteId || ''
        let here
        if (siteId) here = siteId === site.id
        else if (src.key === 'incidents')
          here = siteStats(site, { incidents: [d] }).incidentsTotal === 1
        else {
          const name = src.key === 'drills' ? d.centerName : d.siteName
          here = Boolean(name && resolveSite(name, sites)?.site.id === site.id)
        }
        if (here && norm !== 'done') items.push({ due: a.due, norm })
      }
    }
  }

  const inc = incidents.filter(
    (i) => !i.deletedAt && siteStats(site, { incidents: [i] }).incidentsTotal === 1
  )
  const exts = extinguishers.filter((x) => !x.deletedAt && onSite(x))
  return {
    extinguishers: stats.extinguishers,
    hptOverdue: exts.filter((x) => {
      const d = deriveStatus(x, NOW)
      return !d.isClosed && d.flags.HPT_DUE
    }).length,
    openDefects: extRows.length + assetRows.length,
    defectsByKind: {
      extinguisher: extRows.length,
      aed: assetRows.filter(({ r }) => r.assetKind !== 'fas').length,
      fas: assetRows.filter(({ r }) => r.assetKind === 'fas').length,
    },
    firstAidBoxes: stats.firstAidBoxes,
    aeds: stats.aeds,
    aedsOutOfService: siteStats(site, {
      aeds: aeds.filter((a) => a.status === 'out_of_service'),
      links,
    }).aeds,
    pendingActions: items.length,
    overdueActions: items.filter((a) => isOverdue(a.due, a.norm, todayISO(TODAY))).length,
    incidentsTotal: stats.incidentsTotal,
    incidentsOpen: inc.filter((i) => i.lifecycle !== 'closed' && i.lifecycle !== 'verified').length,
    incidents90d: inc.filter(
      (i) => i.incidentDate >= '2026-07-14' && i.incidentDate <= '2026-10-12'
    ).length,
  }
}

describe('the hydrostatic calendar is Asia/Kolkata on both sides', () => {
  it('agrees on the instant Kolkata changes day', () => {
    const before = new Date('2026-10-11T18:29:00Z')
    const after = new Date('2026-10-11T18:31:00Z')
    expect(appIstDay(before)).toBe('2026-10-11')
    expect(serverIstDay(before)).toBe(appIstDay(before))
    expect(appIstDay(after)).toBe('2026-10-12')
    expect(serverIstDay(after)).toBe(appIstDay(after))
  })
})

describe('WhatsApp site summary matches the app, site by site', () => {
  const server = summariseSites(
    {
      sites,
      extinguishers,
      aeds,
      fas,
      reports,
      incidents,
      mockDrills,
      inspectionRecords,
      auditFindings,
    },
    { now: NOW }
  )

  it.each(sites.map((s) => [s.id, s]))('%s', (_id, site) => {
    expect(server[site.id]).toEqual(appNumbers(site))
  })

  it('keeps a closed HPT in the overdue count and out of the open defects', () => {
    expect(server.s4).toMatchObject({ extinguishers: 1, hptOverdue: 1, openDefects: 0 })
  })

  // Guard against a fixture that tests nothing: the cases above must exercise
  // every branch with a non-zero number somewhere.
  it('exercises every count', () => {
    const totals = {}
    for (const c of Object.values(server)) {
      for (const [k, v] of Object.entries(c))
        if (typeof v === 'number') totals[k] = (totals[k] || 0) + v
    }
    for (const k of [
      'extinguishers',
      'hptOverdue',
      'openDefects',
      'firstAidBoxes',
      'pendingActions',
      'overdueActions',
      'incidentsTotal',
      'incidentsOpen',
      'incidents90d',
    ]) {
      expect(totals[k], k).toBeGreaterThan(0)
    }
  })
})
