// Invented sample records for every module of the GitHub Pages demo, one block
// per module. Split from seed.js only for length; the rules there apply here:
// every person, site and event is made up, and dates are relative to the day
// the demo is opened so "overdue" and "due soon" stay true whenever it is read.
//
// Each block writes exactly the shape that module's own create path writes.
// That is the point of the demo: a record seeded in a shape the app never
// produces would render as "undefined" or drop out of a filter, and the demo
// would show a defect the product does not have. Where a module's write path is
// cheap and has no side effects worth avoiding (LOTO's batch, the PTW mirror),
// it is called directly so the shape cannot drift; where it renders a PDF or
// sends mail (mock drills, committee minutes), the payload is written by hand.
//
// The demo runs with encryption off (getDataKeys answers {}), so fields that
// src/shared/crypto/policy.js would seal are stored as plain values here.
import { serverTimestamp, Timestamp } from '../shared/data/client.js'
import { reserveDocId } from '../shared/docId/reserve'
import { ensurePermitQr } from '../modules/ptw/lib/data'
import { computeWindow } from '../modules/ptw/lib/permitStatus'
import { generateQrToken } from '../modules/ptw/lib/qr'
import {
  ppeGroupsFor,
  precautionGroupsFor,
  requiredDocsFor,
  jsaSuggestionsFor,
} from '../modules/ptw/lib/ptwData'
import { createProcedure, approveProcedure } from '../modules/loto/services/procedures'
import { numberIsolationPoints, buildProcedureCode } from '../modules/loto/utils/codes'
import { getActiveChecklist } from '../modules/fire/lib/mockDrillTemplates'
import { classificationFields } from '../modules/documents/lib/classification'
import { storageKindFor } from '../modules/documents/lib/docTypes'
import { merakiDocId } from '../modules/cctv/lib/provision'

const ORG_NAME = 'Demo Industries'
const ADMIN = { uid: 'demo-admin', name: 'Alex Admin' }
const MANAGER = { uid: 'demo-manager', name: 'Morgan Manager' }
const EMPLOYEE = { uid: 'demo-employee', name: 'Eli Employee' }

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
/** An ISO instant `offset` days from now at a fixed local hour. */
const at = (offset, hour = 10) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

export async function seedModules(put, { day, sites }) {
  const site = (id) => sites.find((s) => s.id === id)
  await seedRiskAssessments(put, day, site)
  // LOTO first: the electrical permit names an approved LOTO procedure
  // (stack/policy.mjs permitLotoProblem).
  await seedLoto(put, day, site)
  await seedPermits(put, day, site)
  await seedInspections(put, day, site)
  await seedAudits(put, day, site)
  await seedCommittee(put, day)
  await seedMockDrills(put, day, site)
  await seedDocuments(put, day, sites)
  await seedEmergency(put, day, site)
  await seedObjectives(put)
  await seedCctv(put, day, sites)
  await seedStakeholder(put, day, site)
  await seedTraining(put, day, site)
}

// ── Risk Assessment (hira) ───────────────────────────────────────────────────
async function seedRiskAssessments(put, day, site) {
  const control = (id, hierarchy, description, extra = {}) => ({
    id,
    hierarchy,
    description,
    responsibleMemberId: '',
    department: '',
    status: 'Implemented',
    dueDate: '',
    ...extra,
  })
  const hazard = (id, fields) => ({
    id,
    whoMightBeHarmed: 'Employees, contractors',
    specificLocation: '',
    controls: [],
    alarp: false,
    additionalControls: [],
    projectedProbability: null,
    projectedSeverity: null,
    ...fields,
  })

  const harbour = site('site-harbour')
  await put('assessments', 'ra-harbour-yard', {
    name: 'Yard traffic and loading operations',
    kind: 'site',
    baselineId: '',
    siteName: harbour.name,
    region: harbour.region,
    entity: harbour.entity,
    siteId: harbour.id,
    location: 'Loading yard and dock doors 1–6',
    assessmentDate: day(-40),
    status: 'ACTIVE',
    refId: 'HIRA-HARBOU-D3M0A1',
    members: [
      {
        id: 'm-h1',
        name: MANAGER.name,
        email: 'manager@demo.test',
        role: 'Assessment lead',
        department: 'Safety',
        type: 'internal',
      },
      {
        id: 'm-h2',
        name: EMPLOYEE.name,
        email: 'employee@demo.test',
        role: 'Forklift operator',
        department: 'Operation',
        type: 'internal',
      },
      {
        id: 'm-h3',
        name: 'Sam Contractor',
        email: '',
        role: 'Haulage supervisor',
        department: 'External',
        type: 'external',
      },
    ],
    activities: [
      {
        id: 'a-h1',
        title: 'Forklift movement between racking and dock',
        nature: 'Routine',
        hazards: [
          hazard('h-h1', {
            description: 'Forklift striking a pedestrian at blind corners',
            hazardGroup: 'Safety',
            hazardCategory: 'Motorized_Vehicle_Operation',
            hazardType: 'Interaction (PIT/Pedestrians)',
            specificLocation: 'Aisle ends, dock door 3',
            probability: 4,
            severity: 4,
            controls: [
              control('c-h1', 'Engineering Control', 'Convex mirrors at aisle ends'),
              control('c-h2', 'Administrative Control', 'Site speed limit of 8 km/h'),
            ],
            // The open, overdue additional control the HIRA Action Tracker shows.
            additionalControls: [
              control(
                'c-h3',
                'Engineering Control',
                'Install physical barrier on the pedestrian walkway',
                {
                  responsibleMemberId: 'm-h1',
                  department: 'Operation',
                  status: 'Open',
                  dueDate: day(-5),
                }
              ),
              control(
                'c-h4',
                'Administrative Control',
                'Blue-spot warning lights on all forklifts',
                {
                  responsibleMemberId: 'm-h2',
                  department: 'Operation',
                  status: 'In Progress',
                  dueDate: day(12),
                }
              ),
            ],
            projectedProbability: 2,
            projectedSeverity: 4,
          }),
          hazard('h-h2', {
            description: 'Load falling from raised forks',
            hazardGroup: 'Safety',
            hazardCategory: 'Gravity_Access',
            hazardType: 'Suspended load',
            probability: 2,
            severity: 3,
            controls: [control('c-h5', 'Administrative Control', 'Pallets wrapped before lifting')],
            alarp: true,
          }),
        ],
      },
      {
        id: 'a-h2',
        title: 'Manual unloading of mixed cartons',
        nature: 'Routine',
        hazards: [
          hazard('h-h3', {
            description: 'Back strain from repeated lifting',
            hazardGroup: 'Health',
            hazardCategory: 'Ergonomic',
            hazardType: 'Manual handling',
            probability: 3,
            severity: 2,
            controls: [
              control('c-h6', 'Engineering Control', 'Roller conveyor at the trailer mouth'),
              control(
                'c-h7',
                'Administrative Control',
                'Manual handling training for the dock team'
              ),
            ],
            additionalControls: [
              control('c-h8', 'Administrative Control', 'Job rotation every two hours', {
                responsibleMemberId: 'm-h1',
                status: 'Implemented',
                dueDate: day(-20),
              }),
            ],
            projectedProbability: 2,
            projectedSeverity: 2,
          }),
        ],
      },
    ],
    docId: await reserveDocId('hira'),
    createdBy: MANAGER.uid,
    createdByName: MANAGER.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  const valley = site('site-valley')
  await put('assessments', 'ra-valley-maint', {
    name: 'Workshop maintenance tasks',
    kind: 'site',
    baselineId: '',
    siteName: valley.name,
    region: valley.region,
    entity: valley.entity,
    siteId: valley.id,
    location: 'Maintenance workshop',
    assessmentDate: day(-120),
    status: 'ACTIVE',
    refId: 'HIRA-VALLEY-D3M0B2',
    members: [
      {
        id: 'm-v1',
        name: MANAGER.name,
        email: 'manager@demo.test',
        role: 'Assessment lead',
        department: 'Safety',
        type: 'internal',
      },
    ],
    activities: [
      {
        id: 'a-v1',
        title: 'Electrical panel maintenance',
        nature: 'Non-routine',
        hazards: [
          hazard('h-v1', {
            description: 'Contact with live parts during fault finding',
            hazardGroup: 'Safety',
            hazardCategory: 'Electrical',
            hazardType: 'Live parts',
            probability: 3,
            severity: 5,
            controls: [
              control('c-v1', 'Elimination', 'Isolate and lock out before any panel work'),
              control('c-v2', 'PPE', 'Arc-rated gloves and face shield'),
            ],
            additionalControls: [
              control('c-v3', 'Administrative Control', 'Annual authorisation for electricians', {
                responsibleMemberId: 'm-v1',
                status: 'Implemented',
                dueDate: day(-60),
              }),
            ],
            projectedProbability: 1,
            projectedSeverity: 5,
          }),
        ],
      },
      {
        id: 'a-v2',
        title: 'Grinding and cutting',
        nature: 'Routine',
        hazards: [
          hazard('h-v2', {
            description: 'Noise exposure above the action level',
            hazardGroup: 'Health',
            hazardCategory: 'Noise_Vibration_Work_Environment',
            hazardType: 'Noise',
            probability: 3,
            severity: 2,
            controls: [control('c-v4', 'PPE', 'Ear defenders issued and worn')],
            additionalControls: [
              control('c-v5', 'Substitution', 'Replace the bench grinder with a low-noise model', {
                responsibleMemberId: 'm-v1',
                status: 'Open',
                dueDate: day(25),
              }),
            ],
            projectedProbability: 2,
            projectedSeverity: 2,
          }),
        ],
      },
    ],
    docId: await reserveDocId('hira'),
    createdBy: ADMIN.uid,
    createdByName: ADMIN.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

// ── Permit to Work ───────────────────────────────────────────────────────────
async function seedPermits(put, day, site) {
  const decision = (status, who, when, note = '') => ({
    status,
    by: status === 'pending' ? null : who.uid,
    byName: status === 'pending' ? '' : who.name,
    at: status === 'pending' ? null : when,
    note,
  })
  const pending = () => decision('pending')
  // The permit's own window: built from local date + time exactly as the form
  // collects them, so an "in progress" permit really is inside its 8 hours.
  const startedAgo = (hours, daysBack = 0) => {
    const d = new Date(Date.now() - hours * 3600000)
    d.setDate(d.getDate() - daysBack)
    return { date: localDate(d), time: localTime(d) }
  }
  const permit = (n, typeOfWork, s, fields) => {
    const when = fields.when
    const { validFrom, validTo } = computeWindow(when.date, when.time)
    return {
      permitNo: `PTW-${when.date.slice(0, 4)}-${pad4(n)}`,
      qrToken: generateQrToken(),
      date: when.date,
      time: when.time,
      typeOfWork,
      site: s.name,
      siteId: s.id,
      jobLocation: fields.jobLocation,
      jobDescription: fields.jobDescription,
      issuingDepartment: fields.issuingDepartment,
      issuedToName: fields.issuedToName,
      issuedToPhone: '+91 90000 00000',
      hazards: fields.hazards,
      ppe: ppeGroupsFor(typeOfWork).flatMap((g) => g.items),
      precautions: precautionGroupsFor(typeOfWork).flatMap((g) => g.items),
      participants: fields.participants,
      jsa: jsaSuggestionsFor(typeOfWork),
      fireWatchers: fields.fireWatchers || [],
      confinedWatcher: null,
      requiredDocs: requiredDocsFor(typeOfWork),
      attachedDocKeys: [],
      assignedEngineer: null,
      assignedOperator: null,
      engineering: fields.engineering,
      operations: fields.operations,
      closure: fields.closure || null,
      extension: null,
      validFrom,
      validTo,
      storedStatus: fields.storedStatus,
      createdBy: MANAGER.uid,
      createdByName: MANAGER.name,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
  }

  const live = startedAgo(2)
  const liveAt = new Date(Date.now() - 2.5 * 3600000).toISOString()
  const ridge = site('site-ridge')
  const p1 = permit(1, 'Hot Work', ridge, {
    when: live,
    jobLocation: 'Boiler house, east wall',
    jobDescription: 'Weld a replacement bracket on the steam header support',
    issuingDepartment: 'Engineering',
    issuedToName: 'Sam Contractor',
    hazards: ['Flammables', 'Hot Materials', 'Fumes/Dust'],
    participants: [
      {
        type: 'contractor',
        name: 'Sam Contractor',
        company: 'Example Fabrication Co.',
        contact: '',
      },
      { type: 'employee', name: EMPLOYEE.name, company: ORG_NAME, contact: '' },
    ],
    fireWatchers: [{ name: 'Robin Watcher', details: 'Extinguisher and blanket on standby' }],
    engineering: decision('approved', MANAGER, liveAt),
    operations: decision('approved', ADMIN, liveAt),
    storedStatus: 'in_progress',
  })

  const harbour = site('site-harbour')
  const p2 = permit(2, 'Height Work', harbour, {
    when: { date: day(1), time: '09:00' },
    jobLocation: 'Warehouse roof, skylight row B',
    jobDescription: 'Replace two cracked roof skylight panels',
    issuingDepartment: 'Operation',
    issuedToName: EMPLOYEE.name,
    hazards: ['Lone Work'],
    participants: [{ type: 'employee', name: EMPLOYEE.name, company: ORG_NAME, contact: '' }],
    engineering: pending(),
    operations: pending(),
    storedStatus: 'draft',
  })

  const closedWhen = startedAgo(0, 6)
  const closedAt = at(-6, 16)
  const valley = site('site-valley')
  const p3Base = permit(3, 'Electrical Work', valley, {
    when: { date: closedWhen.date, time: '08:30' },
    jobLocation: 'Main distribution board, panel MDB-2',
    jobDescription: 'Replace a failed incomer breaker',
    issuingDepartment: 'Engineering',
    issuedToName: 'Jo Electrician',
    hazards: ['Auto Start Equipment'],
    participants: [{ type: 'employee', name: 'Jo Electrician', company: ORG_NAME, contact: '' }],
    engineering: decision('approved', MANAGER, at(-6, 8)),
    operations: decision('approved', ADMIN, at(-6, 8)),
    closure: {
      requestedBy: MANAGER.uid,
      requestedByName: MANAGER.name,
      requestedAt: at(-6, 15),
      engineering: decision('approved', MANAGER, closedAt),
      operations: decision('approved', ADMIN, closedAt),
    },
    storedStatus: 'closed',
  })
  // Electrical work names the LOTO procedure isolating its equipment
  // (seedLoto: proc-compressor, approved, at the same site).
  const p3 = {
    ...p3Base,
    lotoProcedureId: 'proc-compressor',
    lotoProcedureCode: buildProcedureCode({ orgName: ORG_NAME, site: valley.name, equipment: 'Air compressor AC-1' }),
    lotoEquipment: 'Air compressor AC-1',
  }

  let n = 0
  for (const p of [p1, p2, p3]) {
    n += 1
    const id = `permit-${n}`
    const body = { ...p, docId: await reserveDocId('ptw') }
    await put('permits', id, body)
    // The public QR mirror through the module's own builder, so a scan of the
    // demo's printed permit opens a page with the same fields the real one has.
    await ensurePermitQr(ORG_NAME, { ...body, id })
  }
  // The next permit raised in the demo continues the sequence instead of
  // reusing PTW-…-0001.
  await put('meta', 'counters', { permitSeq: 3 })
}
const pad4 = (n) => String(n).padStart(4, '0')

// ── Inspections ──────────────────────────────────────────────────────────────
async function seedInspections(put, day, site) {
  const field = (id, label, category, type = 'Pass/Fail', options = []) => ({
    id,
    label,
    category,
    type,
    photoRequirement: 'Not Required',
    options,
  })
  const walkFields = [
    field('f-walk-1', 'Fire exits and escape routes clear', 'Fire safety'),
    field('f-walk-2', 'Extinguishers in place and tagged', 'Fire safety'),
    field('f-walk-3', 'Floor free of spills and trip hazards', 'Housekeeping'),
    field('f-walk-4', 'Racking undamaged and loads within limit', 'Storage'),
    field('f-walk-5', 'Number of people on shift', 'General', 'Number'),
  ]
  const harbour = site('site-harbour')
  // Recurring monthly at Harbour from 50 days ago: the first slot is done (the
  // record below), the next is overdue, the one after is upcoming — so the
  // Schedule calendar and the Overdue tab both have something to show.
  const firstSlot = day(-50)
  await put('inspectionTemplates', 'tpl-walk', {
    title: 'Monthly safety walk',
    desc: 'General workplace safety walk-round for warehouse sites.',
    siteId: harbour.id,
    siteName: harbour.name,
    frequency: 'Monthly',
    status: 'Active',
    assignedFrom: firstSlot,
    assignedTo: '',
    fields: walkFields,
    assignments: [],
    createdBy: MANAGER.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  const valley = site('site-valley')
  const coastal = site('site-coastal')
  const assignment = (id, s, scheduledDate, area, notes) => ({
    id,
    siteId: s.id,
    siteName: s.name,
    area,
    scheduledDate,
    frequency: '',
    endDate: '',
    status: 'Pending',
    notes,
    createdAt: at(-10),
    createdBy: 'manager@demo.test',
    history: [],
  })
  await put('inspectionTemplates', 'tpl-forklift', {
    title: 'Forklift pre-use check',
    desc: 'Operator check before the first use of the shift.',
    siteId: '',
    siteName: '',
    frequency: 'On Demand',
    status: 'Active',
    assignedFrom: '',
    assignedTo: '',
    fields: [
      field('f-fl-1', 'Horn and reversing alarm working', 'Controls'),
      field('f-fl-2', 'Forks and chains free of cracks', 'Structure'),
      field('f-fl-3', 'Seat belt fitted and working', 'Controls'),
      field('f-fl-4', 'Fuel / charge level', 'General', 'Single Choice', ['Full', 'Half', 'Low']),
    ],
    assignments: [
      assignment(
        'asn-demo-1',
        valley,
        day(-3),
        'Workshop yard',
        'Spot check after the racking strike'
      ),
      assignment('asn-demo-2', coastal, day(6), 'Loading bay', ''),
    ],
    createdBy: MANAGER.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  const answer = (f, value, extra = {}) => ({
    label: f.label,
    category: f.category,
    type: f.type,
    answer: value,
    observation: '',
    action: '',
    actionOwner: '',
    actionDue: '',
    photoEvidence: null,
    photoEvidenceName: '',
    ...extra,
  })
  const [w1, w2, w3, w4, w5] = walkFields
  await put('inspectionRecords', 'insp-1', {
    docId: await reserveDocId('inspections'),
    templateId: 'tpl-walk',
    templateTitle: 'Monthly safety walk',
    siteId: harbour.id,
    siteName: harbour.name,
    area: 'Dock doors 1–6',
    inspector: MANAGER.name,
    completedAt: at(-50, 11),
    scheduledFor: firstSlot,
    dueString: firstSlot,
    frequency: 'Monthly',
    score: 75,
    passFailResult: 'FAIL',
    responses: {
      [w1.id]: answer(w1, 'Pass'),
      [w2.id]: answer(w2, 'Pass'),
      // The failed item: a corrective action in the central Action Tracker.
      [w3.id]: answer(w3, 'Fail', {
        observation: 'Shrink-wrap offcuts and a hydraulic oil drip by dock door 4',
        action: 'Clean the spill, fix the leaking truck and add a waste bin at door 4',
        actionOwner: EMPLOYEE.name,
        actionDue: day(-36),
        actionStatus: 'open',
        repeatCount: 1,
        repeatSince: firstSlot,
      }),
      [w4.id]: answer(w4, 'Pass'),
      [w5.id]: answer(w5, '14'),
    },
    createdAt: serverTimestamp(),
    createdByUid: MANAGER.uid,
  })

  const ridge = site('site-ridge')
  const fl = ['f-fl-1', 'f-fl-2', 'f-fl-3']
  const labels = {
    'f-fl-1': ['Horn and reversing alarm working', 'Controls'],
    'f-fl-2': ['Forks and chains free of cracks', 'Structure'],
    'f-fl-3': ['Seat belt fitted and working', 'Controls'],
  }
  const passResponses = Object.fromEntries(
    fl.map((id) => [
      id,
      answer({ label: labels[id][0], category: labels[id][1], type: 'Pass/Fail' }, 'Pass'),
    ])
  )
  passResponses['f-fl-4'] = answer(
    { label: 'Fuel / charge level', category: 'General', type: 'Single Choice' },
    'Full'
  )
  await put('inspectionRecords', 'insp-2', {
    docId: await reserveDocId('inspections'),
    templateId: 'tpl-forklift',
    templateTitle: 'Forklift pre-use check',
    siteId: ridge.id,
    siteName: ridge.name,
    area: 'Truck FL-02',
    inspector: EMPLOYEE.name,
    completedAt: at(-6, 7),
    scheduledFor: '',
    dueString: '',
    frequency: 'On Demand',
    score: 100,
    passFailResult: 'PASS',
    responses: passResponses,
    createdAt: serverTimestamp(),
    createdByUid: EMPLOYEE.uid,
  })
}

// ── Internal Audit ───────────────────────────────────────────────────────────
async function seedAudits(put, day, site) {
  const ridge = site('site-ridge')
  const standard = 'ISO 45001:2018'
  const planDocId = await reserveDocId('audit')
  const rows = [
    {
      auditor: MANAGER.name,
      auditee: EMPLOYEE.name,
      dept: 'Operation',
      area: 'Warehouse',
      aspect: 'Housekeeping & storage',
      date: day(-30),
      time: '10:00',
    },
    {
      auditor: MANAGER.name,
      auditee: ADMIN.name,
      dept: 'Safety',
      area: 'Training records',
      aspect: 'Competence (7.2)',
      date: day(-28),
      time: '14:00',
    },
    {
      auditor: ADMIN.name,
      auditee: MANAGER.name,
      dept: 'Maintenance',
      area: 'Workshop',
      aspect: 'Operational control (8.1)',
      date: day(-60),
      time: '11:00',
    },
    {
      auditor: ADMIN.name,
      auditee: EMPLOYEE.name,
      dept: 'Operation',
      area: 'Dock office',
      aspect: 'Emergency preparedness (8.2)',
      date: day(9),
      time: '10:30',
    },
  ]
  await put('auditPlans', 'plan-ridge', {
    siteId: ridge.id,
    region: ridge.region,
    entity: ridge.entity,
    centerCode: '',
    leadAuditor: MANAGER.name,
    team: [MANAGER.name, ADMIN.name],
    standard,
    startDate: day(-60),
    endDate: day(15),
    docId: planDocId,
    matrix: rows,
    createdAt: at(-75),
    createdBy: MANAGER.name,
    status: 'Planned',
    _serverCreatedAt: serverTimestamp(),
  })

  // The task object AuditorWorkplace builds from a plan row, which is what
  // createAuditFinding stores as taskDetails.
  const task = (row) => ({
    ...row,
    planId: planDocId,
    siteId: ridge.id,
    leadAuditor: MANAGER.name,
    standard,
    scope: 'OH&S Management System',
    status: 'Planned',
    _key: `${planDocId}_${row.area}_${row.auditee}`,
    criteria: standard,
  })
  const finding = (id, type, desc, clause, due, extra = {}) => ({
    id,
    type,
    desc,
    clause,
    evidence: '',
    fileName: '',
    auditeeDueDate: due,
    ...extra,
  })
  const users = { [EMPLOYEE.name]: EMPLOYEE, [ADMIN.name]: ADMIN, [MANAGER.name]: MANAGER }
  const record = async (row, status, findings, extra = {}) => ({
    docId: await reserveDocId('auditFindings'),
    taskDetails: task(row),
    findings,
    status,
    auditDate: `${row.date}T${row.time}:00.000Z`,
    auditor: row.auditor,
    siteId: ridge.id,
    createdByUid: users[row.auditor].uid,
    auditeeUid: users[row.auditee].uid,
    _serverCreatedAt: serverTimestamp(),
    ...extra,
  })

  await put(
    'auditFindings',
    'af-1',
    await record(rows[0], 'Reported', [
      finding(
        'AF-demo-1',
        'Minor NC',
        'Pallets stored in front of the fire exit on aisle 7',
        '8.2',
        day(-15)
      ),
      finding('AF-demo-2', 'OFI', 'Floor markings faded at the dock entrance', '8.1', day(0)),
    ])
  )

  const response = (capa, owner, targetDate) => ({
    rootCause: 'No named owner for the check in the shift handover',
    correction: 'Records brought up to date the same week',
    capa,
    owner,
    targetDate,
    evidenceFile: null,
    evidenceFileName: '',
    evidenceFilePath: '',
    status: 'Completed',
    capaStatus: 'Open',
  })
  await put(
    'auditFindings',
    'af-2',
    await record(
      rows[1],
      'Submitted for Verification',
      [
        finding(
          'AF-demo-3',
          'Minor NC',
          'Two forklift licences past their renewal date',
          '7.2',
          day(-13),
          {
            response: response(
              'Add licence expiry to the monthly training report',
              ADMIN.name,
              day(10)
            ),
          }
        ),
      ],
      { submissionDate: at(-4) }
    )
  )

  await put(
    'auditFindings',
    'af-3',
    await record(
      rows[2],
      'Closed',
      [
        finding(
          'AF-demo-4',
          'Observation',
          'Machine guard interlock tested and logged weekly',
          '8.1',
          day(-30),
          {
            response: {
              ...response('Keep the weekly test in the PM schedule', MANAGER.name, day(-35)),
              capaStatus: 'Closed',
            },
          }
        ),
      ],
      { submissionDate: at(-40), closureDate: at(-38) }
    )
  )
}

// ── LOTO ─────────────────────────────────────────────────────────────────────
async function seedLoto(put, day, site) {
  const ridge = site('site-ridge')
  const actor = { id: MANAGER.uid, displayName: MANAGER.name }
  const point = (
    key,
    energySource,
    devices,
    isolationDetails,
    hazard,
    verification,
    rating = ''
  ) => ({
    key,
    energySource,
    devices,
    rating,
    isolationDetails,
    hazard,
    verification,
    lockState: { locked: false, lockedBy: null, lockedByName: null, lockedAt: null },
  })
  const procedure = (s, equipment, equipmentDetails, points) => ({
    orgName: ORG_NAME,
    site: s.name,
    region: s.region,
    entity: s.entity,
    siteId: s.id,
    equipment,
    equipmentDetails,
    procedureCode: buildProcedureCode({ orgName: ORG_NAME, site: s.name, equipment }),
    isolationPoints: numberIsolationPoints(points),
  })

  // Through the module's own write path: it builds the lock summary and the
  // public QR mirror in the same batch, which is a shape worth not copying.
  await createProcedure(
    'proc-conveyor',
    procedure(
      ridge,
      'Packing line conveyor C-3',
      'Belt conveyor, 7.5 kW drive, pneumatic diverter',
      [
        point(
          'pt-c1',
          'electrical',
          ['safety_padlock', 'hasp'],
          'Isolator IS-C3 at MCC-2, switch to OFF',
          'Unexpected start of the belt',
          'Press local START; belt must not move',
          '415 V'
        ),
        point(
          'pt-c2',
          'pneumatic',
          ['ball_valve_lock'],
          'Close ball valve BV-12 and bleed the diverter line',
          'Diverter arm moving under stored air',
          'Gauge PG-12 reads zero',
          '6 bar'
        ),
        point(
          'pt-c3',
          'gravitational',
          ['pin_inout'],
          'Insert the pin in the take-up weight frame',
          'Take-up weight dropping',
          'Weight resting on the pin'
        ),
      ]
    ),
    actor
  )
  await approveProcedure('proc-conveyor', actor)

  const valley = site('site-valley')
  await createProcedure(
    'proc-compressor',
    procedure(valley, 'Air compressor AC-1', 'Screw compressor with receiver tank', [
      point(
        'pt-a1',
        'electrical',
        ['safety_padlock'],
        'Main breaker Q1 in panel P-4',
        'Motor start',
        'Try start from the local panel',
        '415 V'
      ),
      point(
        'pt-a2',
        'pneumatic',
        ['gate_valve_lock'],
        'Close outlet valve V-1 and open the drain',
        'Release of stored air',
        'Receiver gauge at zero'
      ),
    ]),
    actor
  )

  await approveProcedure('proc-compressor', actor)

  const expires = (offset) => Timestamp.fromDate(new Date(`${day(offset)}T23:59:59`))
  const technicians = [
    ['tech-1', 'Jo Electrician', 'P-101', 'WL-2024-0101', 400],
    ['tech-2', 'Robin Fitter', 'P-102', 'WL-2023-0102', 20],
    ['tech-3', 'Casey Mechanic', 'P-103', 'WL-2022-0103', -15],
  ]
  for (const [id, name, lockNo, licenceNo, exp] of technicians) {
    await put('technicians', id, {
      name,
      lockNo,
      contact: '+91 90000 00000',
      licenceNo,
      active: true,
      createdBy: ADMIN.uid,
      createdAt: serverTimestamp(),
      licenceExp: expires(exp),
    })
  }

  const lock = (lockNo, tagNo, color, serviceStatus = 'available') => ({
    lockNo,
    tagNo,
    color,
    type: 'department',
    serviceStatus,
    useCount: 0,
    history: [],
    openPermitId: '',
    active: true,
    createdBy: ADMIN.uid,
    createdAt: serverTimestamp(),
  })
  await put('locks', 'lock-d1', lock('D-201', 'T-201', 'red'))
  await put('locks', 'lock-d2', lock('D-202', 'T-202', 'red'))
  await put('locks', 'lock-d3', lock('D-203', 'T-203', 'blue', 'out_of_service'))
}

// ── HSE Committee ────────────────────────────────────────────────────────────
async function seedCommittee(put, day) {
  const attendee = (u, role, dept) => ({ userId: u.uid, name: u.name, role, dept })
  const action = (text, owner, due, status, department = '') => ({
    action: text,
    ownerKind: department ? 'department' : 'person',
    owner: department ? '' : owner,
    department,
    due,
    status,
  })
  const meeting = async (siteId, type, subject, date, minutes, attendees, actions) => ({
    siteId,
    type,
    subject,
    date,
    time: '15:00',
    preRequisites: 'Last month’s incident summary and open actions list',
    minutes,
    attendees,
    actions,
    timestamp: `${date}T16:00:00.000Z`,
    createdBy: MANAGER.name,
    docId: await reserveDocId('committee'),
    createdByUid: MANAGER.uid,
    createdAt: serverTimestamp(),
  })
  const roster = [
    attendee(MANAGER, 'manager', 'Safety'),
    attendee(ADMIN, 'admin', 'Safety'),
    attendee(EMPLOYEE, 'member', 'Operation'),
  ]
  await put(
    'consultations',
    'mtg-1',
    await meeting(
      'site-harbour',
      'HSE Committee Meeting',
      'Quarterly HSE committee — yard traffic and housekeeping',
      day(-35),
      'Reviewed the forklift near miss and the open walkway barrier action.\nAgreed a trial of blue-spot lights on two trucks.\nHousekeeping at the dock doors to be checked on every safety walk.',
      [
        ...roster,
        { userId: 'External', name: 'Sam Contractor', role: 'External / Contractor', dept: 'N/A' },
      ],
      [
        // Open and overdue: the committee row in the central Action Tracker.
        action('Fit blue-spot lights to forklifts FL-01 and FL-02', EMPLOYEE.name, day(-7), 'Open'),
        action(
          'Repaint the pedestrian crossing at dock door 3',
          '',
          day(-14),
          'Closed',
          'Operation'
        ),
      ]
    )
  )
  await put(
    'consultations',
    'mtg-2',
    await meeting(
      'site-ridge',
      'Emergency Planning',
      'Emergency planning — evacuation drill review',
      day(-8),
      'Evacuation drill took 4 minutes 10 seconds against a 4 minute target.\nAssembly point signage at the north gate is missing.',
      roster.slice(0, 2),
      [
        action(
          'Install assembly point sign at the north gate',
          MANAGER.name,
          day(10),
          'In Progress'
        ),
        action('Brief night shift on the revised muster roll', '', day(20), 'Open', 'Operation'),
      ]
    )
  )
}

// ── Mock Drills ──────────────────────────────────────────────────────────────
async function seedMockDrills(put, day, site) {
  const drill = async (s, fields) => {
    const checklist = getActiveChecklist(
      fields.scenario,
      fields.fireSource,
      fields.medicalIncidentType
    )
    const done = fields.checksDone
    const checklistStatus = Object.fromEntries(checklist.map((_, i) => [i, i < done]))
    return {
      centerName: s.name,
      region: s.region,
      entity: s.entity,
      siteId: s.id,
      eventType: 'Mock Drill',
      date: fields.date,
      time: fields.time,
      fireSource: fields.fireSource || '',
      medicalIncidentType: fields.medicalIncidentType || '',
      evacTimeMin: fields.evacTimeMin,
      ertResponseMin: fields.ertResponseMin,
      headCount: fields.headCount,
      debrief: fields.debrief,
      outcome: fields.outcome,
      scenario: fields.scenario,
      commanders: [MANAGER.name],
      commander: MANAGER.name,
      checklist,
      checklistStatus,
      teamsAlerted: { 2: true, 3: true, 4: true },
      score: checklist.length
        ? Math.round((Math.min(done, checklist.length) / checklist.length) * 100)
        : 0,
      actionLog: fields.actionLog,
      capa: fields.capa.map((c) => ({
        ...c,
        owner: [c.department, c.assignees.map((a) => a.name).join(', ')]
          .filter(Boolean)
          .join(' — '),
        assignedByUid: MANAGER.uid,
      })),
      photoCount: 0,
      loggedBy: MANAGER.name,
      createdAt: serverTimestamp(),
      docId: await reserveDocId('drills'),
    }
  }
  await put(
    'mockDrills',
    'drill-1',
    await drill(site('site-ridge'), {
      scenario: 'Fire Emergency',
      fireSource: 'electrical-panel',
      date: day(-12),
      time: '11:00',
      evacTimeMin: 4.2,
      ertResponseMin: 2,
      headCount: 86,
      checksDone: 5,
      outcome: 'Pass with actions',
      debrief: 'Evacuation slower than target; the north gate assembly sign was missing.',
      actionLog: [
        {
          time: '11:00',
          action: 'Alarm raised from MCP at the packing hall',
          observation: 'Sounder audible everywhere',
        },
        {
          time: '11:04',
          action: 'Roll call complete at the assembly point',
          observation: 'Two visitors not on the log',
        },
      ],
      capa: [
        {
          action: 'Add visitors to the electronic muster roll',
          department: 'Security',
          assignees: [{ uid: MANAGER.uid, name: MANAGER.name }],
          due: day(-2),
          status: 'Open',
        },
        {
          action: 'Install the north gate assembly point sign',
          department: 'Operation',
          assignees: [],
          due: day(10),
          status: 'In Progress',
        },
      ],
    })
  )
  await put(
    'mockDrills',
    'drill-2',
    await drill(site('site-coastal'), {
      scenario: 'Chemical Spill',
      date: day(-45),
      time: '14:30',
      evacTimeMin: 3,
      ertResponseMin: 1.5,
      headCount: 40,
      checksDone: 99,
      outcome: 'Pass',
      debrief: 'Spill kit reached the bay inside two minutes; containment correct.',
      actionLog: [
        {
          time: '14:30',
          action: 'Simulated drum leak at bay 2',
          observation: 'Area cordoned promptly',
        },
      ],
      capa: [
        {
          action: 'Restock absorbent pads in spill kit SK-2',
          department: 'Operation',
          assignees: [{ uid: EMPLOYEE.uid, name: EMPLOYEE.name }],
          due: day(-35),
          status: 'Closed',
        },
      ],
    })
  )
}

// ── Documents & SDS ──────────────────────────────────────────────────────────
async function seedDocuments(put, day, sites) {
  const docAt = async (id, folderId, level, siteId, fields) => {
    const classification = classificationFields({ level, siteId }, sites)
    const region = classification.siteRegion || classification.region || ''
    await put('documents', id, {
      title: fields.title,
      docType: fields.docType,
      source: 'link',
      file: null,
      linkUrl: `https://example.com/demo/${id}.pdf`,
      version: fields.version,
      owner: fields.owner,
      reference: fields.reference || '',
      effectiveDate: fields.effectiveDate,
      reviewDate: fields.reviewDate,
      summary: fields.summary,
      ...classification,
      folderId,
      folder: level === 'org' ? storageKindFor(null) : storageKindFor(region),
      status: 'draft',
      docId: await reserveDocId('documents'),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy: ADMIN.uid,
      createdByName: ADMIN.name,
    })
  }
  await docAt('doc-policy', 'org', 'org', '', {
    title: 'Occupational Health & Safety Policy',
    docType: 'Policy',
    version: '3.0',
    owner: ADMIN.name,
    reference: 'POL-OHS-01',
    effectiveDate: day(-200),
    reviewDate: day(165),
    summary:
      'The organization’s commitment to safe and healthy workplaces, signed by the director.',
  })
  // Review date in the past: flagged as an overdue review.
  await docAt('doc-sop-forklift', 'site:site-harbour/others', 'site', 'site-harbour', {
    title: 'SOP — Forklift operation in the yard',
    docType: 'SOP',
    version: '1.2',
    owner: MANAGER.name,
    reference: 'SOP-HAR-07',
    effectiveDate: day(-400),
    reviewDate: day(-20),
    summary: 'Pre-use checks, speed limits, pedestrian segregation and parking.',
  })
  await docAt('doc-sds-cleaner', 'site:site-ridge/others', 'site', 'site-ridge', {
    title: 'SDS — Alkaline floor cleaner (example product)',
    docType: 'SDS',
    version: '2.1',
    owner: MANAGER.name,
    reference: 'SDS-0042',
    effectiveDate: day(-90),
    reviewDate: day(640),
    summary: 'Corrosive to eyes. Wear goggles and gloves; store away from acids.',
  })
}

// ── Emergency Response ───────────────────────────────────────────────────────
async function seedEmergency(put, day, site) {
  const contact = (kind, role, name, s, extra = {}) => ({
    kind,
    role,
    name,
    phone: extra.phone || '+91 90000 00000',
    altPhone: '',
    email: extra.email || '',
    employeeUid: extra.employeeUid || '',
    department: extra.department || '',
    region: s.region,
    entity: s.entity,
    siteId: s.id,
    site: s.name,
    notes: '',
    address: extra.address || '',
    distanceKm: extra.distanceKm ?? null,
    origin: 'manual',
    createdAt: serverTimestamp(),
    createdBy: ADMIN.uid,
  })
  // A small inline floor plan, so the two ready sites have a layout on file.
  const plan = (label) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240"><rect width="400" height="240" fill="#f8fafc"/><rect x="20" y="20" width="360" height="200" fill="none" stroke="#334155" stroke-width="4"/><line x1="200" y1="20" x2="200" y2="150" stroke="#334155" stroke-width="3"/><rect x="340" y="100" width="40" height="40" fill="#16a34a"/><text x="30" y="45" font-family="sans-serif" font-size="16" fill="#334155">${label}</text><text x="300" y="170" font-family="sans-serif" font-size="12" fill="#16a34a">EXIT / ASSEMBLY</text></svg>`
    )}`

  let n = 0
  for (const id of ['site-harbour', 'site-ridge']) {
    const s = site(id)
    n += 1
    await put(
      'erpContacts',
      `erp-c${n}a`,
      contact('internal', 'CM', MANAGER.name, s, {
        employeeUid: MANAGER.uid,
        email: 'manager@demo.test',
        department: 'Safety',
      })
    )
    await put(
      'erpContacts',
      `erp-c${n}b`,
      contact('internal', 'First Aider', EMPLOYEE.name, s, {
        employeeUid: EMPLOYEE.uid,
        department: 'Operation',
      })
    )
    await put(
      'erpContacts',
      `erp-c${n}c`,
      contact('external', 'Fire Brigade', `${s.name} Fire Station (example)`, s, {
        phone: '+91 22 5550 0101',
        distanceKm: 3.4,
      })
    )
    await put(
      'erpContacts',
      `erp-c${n}d`,
      contact('external', 'Hospital', `${s.region} General Hospital (example)`, s, {
        phone: '+91 22 5550 0102',
        distanceKm: 6.1,
      })
    )

    await put('erpLayouts', s.id, {
      siteId: s.id,
      siteName: s.name,
      floors: [
        {
          id: 'fl-ground',
          label: 'Ground floor',
          dataUrl: plan(`${s.name} — ground floor`),
          fileName: 'ground-floor.svg',
        },
      ],
      updatedAt: serverTimestamp(),
      updatedBy: ADMIN.uid,
      updatedByName: ADMIN.name,
    })

    await put('erpRescuePlans', `erp-plan-${n}`, {
      kind: 'site',
      baselineId: '',
      baselineName: '',
      customized: false,
      revision: 0,
      baselineRevision: 0,
      approvedBy: MANAGER.uid,
      approvedByName: MANAGER.name,
      approvedOn: day(-20),
      siteId: s.id,
      siteName: s.name,
      region: s.region,
      entity: s.entity,
      scenario: 'Fire / Explosion',
      title: `Fire evacuation — ${s.name}`,
      description: 'Full evacuation of the building on a fire alarm or a reported fire.',
      triggers: 'Fire alarm sounding, visible smoke or flame, or a verbal fire report.',
      assemblyPoint: 'Main gate car park',
      steps: [
        {
          id: 'st-0',
          order: 1,
          action: 'Raise the alarm at the nearest call point',
          responsible: 'Anyone discovering the fire',
        },
        {
          id: 'st-1',
          order: 2,
          action: 'Call the fire brigade and the site head',
          responsible: 'Security',
        },
        {
          id: 'st-2',
          order: 3,
          action: 'Sweep the floor and evacuate to the assembly point',
          responsible: 'Floor wardens',
        },
        {
          id: 'st-3',
          order: 4,
          action: 'Take the roll call and report missing persons',
          responsible: 'Site Head',
        },
      ],
      team: [
        { id: 'tm-0', role: 'CM', name: MANAGER.name, phone: '+91 90000 00000', uid: MANAGER.uid },
        {
          id: 'tm-1',
          role: 'First Aider',
          name: EMPLOYEE.name,
          phone: '+91 90000 00000',
          uid: EMPLOYEE.uid,
        },
      ],
      equipment: ['Fire extinguishers', 'Fire blanket', 'Megaphone', 'Muster roll'],
      status: 'approved',
      reviewedOn: day(-20),
      nextReviewOn: day(345),
      docId: await reserveDocId('emergency'),
      createdAt: serverTimestamp(),
      createdBy: MANAGER.uid,
      createdByName: MANAGER.name,
    })
  }
}

// ── Objectives & Targets ─────────────────────────────────────────────────────
async function seedObjectives(put) {
  // The same label Targets.jsx defaults a new target to, so the scorecard
  // treats these as the current period.
  const period = `FY${new Date().getFullYear()}`
  const targets = [
    ['auditPass', 90],
    ['ticketClosure', 95],
    ['extinguisherUptime', 98],
    ['fasUptime', 98],
    ['signageUptime', 95],
    ['incidents', 0],
  ]
  for (const [kpi, target] of targets) {
    await put('objectives', `obj-${kpi}`, {
      kpi,
      level: 'org',
      scope: '',
      scopeLabel: 'Organization',
      entity: 'all',
      target,
      period,
      owner: ADMIN.name,
      ownerUid: ADMIN.uid,
      notes: '',
      docId: await reserveDocId('objectives'),
      createdAt: serverTimestamp(),
      createdBy: ADMIN.uid,
    })
  }
  // One regional override, so the scorecard shows a target that is not the
  // organization default.
  await put('objectives', 'obj-incidents-north', {
    kpi: 'incidents',
    level: 'region',
    scope: 'North',
    scopeLabel: 'North',
    entity: 'all',
    target: 1,
    period,
    owner: MANAGER.name,
    ownerUid: MANAGER.uid,
    notes: 'North carries the two busiest yards.',
    docId: await reserveDocId('objectives'),
    createdAt: serverTimestamp(),
    createdBy: ADMIN.uid,
  })
}

// ── CCTV ─────────────────────────────────────────────────────────────────────
async function seedCctv(put, day, sites) {
  const stamp = { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
  // Every site gets its standard Meraki, under the id provisioning would give
  // it, so the "sites missing a Meraki" prompt does not fire on a fresh demo.
  let ip = 10
  for (const s of sites) {
    ip += 1
    await put('cctvMeraki', merakiDocId(s.id), {
      name: `MX-${s.name}`,
      ipAddress: `10.0.${ip}.1`,
      siteId: s.id,
      siteName: s.name,
      status: 'online',
      defects: [],
      defectReportedOn: '',
      model: 'MX67',
      serial: `Q2XX-DEMO-${ip}`,
      notes: '',
      ...stamp,
    })
  }
  const dvr = (s, name, n) => ({
    name,
    ipAddress: `10.0.${11 + sites.indexOf(s)}.${20 + n}`,
    siteId: s.id,
    siteName: s.name,
    status: 'online',
    defects: [],
    defectReportedOn: '',
    channels: 8,
    make: 'ExampleVision',
    model: 'NVR-8',
    location: 'Security cabin',
    notes: '',
    ...stamp,
  })
  const camera = (s, dvrId, name, location, channel, extra = {}) => ({
    name,
    location,
    dvrId,
    siteId: s.id,
    siteName: s.name,
    status: 'online',
    defects: [],
    defectReportedOn: '',
    make: 'ExampleVision',
    model: 'Dome 4MP',
    channel: String(channel),
    notes: '',
    ...stamp,
    ...extra,
  })
  const harbour = sites.find((s) => s.id === 'site-harbour')
  const ridge = sites.find((s) => s.id === 'site-ridge')
  await put('cctvDvrs', 'dvr-harbour', dvr(harbour, 'DVR-Harbour-01', 1))
  await put('cctvDvrs', 'dvr-ridge', dvr(ridge, 'DVR-Ridge-01', 1))
  await put('cctvCameras', 'cam-h1', camera(harbour, 'dvr-harbour', 'CAM-H01', 'Main gate', 1))
  await put('cctvCameras', 'cam-h2', camera(harbour, 'dvr-harbour', 'CAM-H02', 'Dock doors 1–3', 2))
  // Down: not answering, with nothing upstream to blame.
  await put(
    'cctvCameras',
    'cam-h3',
    camera(harbour, 'dvr-harbour', 'CAM-H03', 'Yard north fence', 3, { status: 'offline' })
  )
  await put('cctvCameras', 'cam-r1', camera(ridge, 'dvr-ridge', 'CAM-R01', 'Packing hall', 1))
  // Defect: online but the picture is unusable.
  await put(
    'cctvCameras',
    'cam-r2',
    camera(ridge, 'dvr-ridge', 'CAM-R02', 'Boiler house door', 2, {
      defects: ['blur'],
      defectReportedOn: day(-4),
      notes: 'Lens dirty after the boiler service',
    })
  )
}

// ── Stakeholder Issues ───────────────────────────────────────────────────────
async function seedStakeholder(put, day, site) {
  const scope = (s) => ({ siteId: s.id, siteName: s.name, region: s.region, entity: s.entity })
  const capa = (id, description, owner, dueDate, status) => ({
    id,
    description,
    owner,
    dueDate,
    status,
    closedAt: status === 'closed' ? at(-3) : '',
  })
  const meta = async (kind) => ({
    docId: await reserveDocId(kind),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: MANAGER.uid,
    createdByName: MANAGER.name,
  })
  const coastal = site('site-coastal')
  await put('escalations', 'esc-1', {
    title: 'Neighbour complaint about night-time truck noise',
    scope: scope(coastal),
    channel: 'email',
    severity: 'high',
    status: 'in_progress',
    raisedOn: day(-18),
    description: 'Residents on the access road report reversing alarms after 22:00.',
    members: [
      {
        memberId: 'N-001',
        name: 'Residents’ association (example)',
        contact: '',
        note: 'Third email this quarter',
      },
    ],
    legalNoticeReceived: false,
    legalNoticeRef: '',
    legalNoticeDate: '',
    capa: [
      capa(
        'capa-e1',
        'Switch night arrivals to broadband reversing alarms',
        MANAGER.name,
        day(-4),
        'open'
      ),
      capa('capa-e2', 'Publish a delivery window to hauliers', ADMIN.name, day(-10), 'closed'),
    ],
    attachments: { cctv: [], ethics: [] },
    owner: MANAGER.name,
    ...(await meta('escalations')),
  })
  await put('escalations', 'esc-2', {
    title: 'Customer report of a damaged pallet delivery',
    scope: scope(site('site-valley')),
    channel: 'phone',
    severity: 'low',
    status: 'resolved',
    raisedOn: day(-30),
    description: 'Pallet wrap torn on arrival; stock replaced the next day.',
    members: [{ memberId: 'C-114', name: 'Example Retail Ltd', contact: '', note: '' }],
    legalNoticeReceived: false,
    legalNoticeRef: '',
    legalNoticeDate: '',
    capa: [
      capa(
        'capa-e3',
        'Add a wrap check to the dispatch checklist',
        MANAGER.name,
        day(-20),
        'closed'
      ),
    ],
    attachments: { cctv: [], ethics: [] },
    owner: MANAGER.name,
    ...(await meta('escalations')),
  })
  // Linked to esc-1: the join lives on the legal issue only (see linkage.js).
  await put('legalIssues', 'legal-1', {
    title: 'Pollution board visit after the noise complaint',
    scope: scope(coastal),
    escalationId: 'esc-1',
    incidentDate: day(-9),
    description: 'Inspector measured boundary noise at night and asked for a mitigation plan.',
    departments: ['pollution'],
    departmentOther: '',
    officials: 'Two inspectors (names on the notice)',
    noticeType: 'improvement',
    noticeRef: 'PCB/DEMO/0001',
    noticeDate: day(-9),
    responseDueDate: day(5),
    status: 'open',
    capa: [
      capa('capa-l1', 'Submit the noise mitigation plan to the board', ADMIN.name, day(5), 'open'),
    ],
    penaltyAmount: 0,
    owner: ADMIN.name,
    ...(await meta('legalIssues')),
  })
  await put('legalIssues', 'legal-2', {
    title: 'Fire NOC renewal inspection',
    scope: scope(site('site-summit')),
    escalationId: '',
    incidentDate: day(-50),
    description: 'Routine renewal inspection; no deficiencies found.',
    departments: ['fire'],
    departmentOther: '',
    officials: 'Station officer',
    noticeType: 'none',
    noticeRef: '',
    noticeDate: '',
    responseDueDate: '',
    status: 'closed',
    capa: [],
    penaltyAmount: 0,
    owner: ADMIN.name,
    ...(await meta('legalIssues')),
  })
}

// ── Training ─────────────────────────────────────────────────────────────────
async function seedTraining(put, day, site) {
  const course = async (name, category, validityMonths, mandatory, description) => ({
    name,
    category,
    deliveryMode: 'classroom',
    validityMonths,
    mandatory,
    description,
    content: [],
    thumbnail: '',
    thumbnailPath: '',
    docId: await reserveDocId('training'),
    createdAt: serverTimestamp(),
    createdBy: ADMIN.uid,
    createdByName: ADMIN.name,
  })
  // The two courses seed.js's assignments point at, now in the full shape
  // createCourse writes. Fire safety is the mandatory one.
  await put(
    'trainingCourses',
    'course-fire',
    await course(
      'Fire safety basics',
      'Fire Safety',
      12,
      true,
      'Alarm, evacuation and first-response extinguisher use.'
    )
  )
  await put(
    'trainingCourses',
    'course-forklift',
    await course(
      'Forklift awareness',
      'Induction',
      24,
      false,
      'Pedestrian safety around lift trucks.'
    )
  )
  await put(
    'trainingCourses',
    'course-firstaid',
    await course(
      'First aid at work',
      'First Aid',
      36,
      false,
      'Three-day workplace first aid certificate.'
    )
  )

  const addMonths = (iso, months) => {
    const [y, m, d] = iso.split('-').map(Number)
    const out = new Date(y, m - 1 + months, d)
    if (out.getDate() !== d) out.setDate(0)
    return localDate(out)
  }
  const record = (c, who, completedOn, s, trainerName) => ({
    courseId: c.id,
    courseName: c.name,
    category: c.category,
    validityMonths: c.validityMonths,
    employeeUid: who.uid,
    employeeName: who.name,
    trainerName,
    completedOn,
    expiresOn: c.validityMonths ? addMonths(completedOn, c.validityMonths) : '',
    region: s.region,
    entity: s.entity,
    siteId: s.id,
    site: s.name,
    notes: '',
    createdAt: serverTimestamp(),
    createdBy: MANAGER.uid,
    createdByName: MANAGER.name,
  })
  const fire = {
    id: 'course-fire',
    name: 'Fire safety basics',
    category: 'Fire Safety',
    validityMonths: 12,
  }
  const forklift = {
    id: 'course-forklift',
    name: 'Forklift awareness',
    category: 'Induction',
    validityMonths: 24,
  }
  const firstAid = {
    id: 'course-firstaid',
    name: 'First aid at work',
    category: 'First Aid',
    validityMonths: 36,
  }
  const harbour = site('site-harbour')
  const ridge = site('site-ridge')
  // Completed a year ago less 20 days, so it expires inside the next 30.
  const expiringOn = addMonths(day(20), -12)
  await put(
    'trainingRecords',
    'tr-1',
    record(fire, MANAGER, expiringOn, ridge, 'Example Fire Training')
  )
  // Expired: a fire course from fourteen months ago.
  await put(
    'trainingRecords',
    'tr-2',
    record(fire, EMPLOYEE, addMonths(day(0), -14), harbour, 'Example Fire Training')
  )
  await put('trainingRecords', 'tr-3', record(forklift, EMPLOYEE, day(-60), harbour, MANAGER.name))
  await put(
    'trainingRecords',
    'tr-4',
    record(firstAid, ADMIN, day(-200), harbour, 'Example First Aid Ltd')
  )
}
