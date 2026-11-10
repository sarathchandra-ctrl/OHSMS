// Invented sample data for the GitHub Pages demo. Every name, site and event
// here is made up (AGENTS.md: seed data is invented). Dates are relative to
// the day the demo is opened, so "overdue" and "due soon" stay meaningful.
import { doc, setDoc, serverTimestamp } from '../shared/data/client.js'
import { db } from '../shared/db'
import { DEMO_ACCOUNTS } from './demoMode'
import { seedModules } from './seedModules'

const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

const SITES = [
  {
    id: 'site-harbour',
    name: 'Harbour Depot',
    region: 'North',
    entity: 'Alpha Logistics',
    lat: 19.08,
    lng: 72.88,
  },
  {
    id: 'site-ridge',
    name: 'Ridge Plant',
    region: 'North',
    entity: 'Beta Foods',
    lat: 19.2,
    lng: 72.97,
  },
  {
    id: 'site-valley',
    name: 'Valley Works',
    region: 'South',
    entity: 'Alpha Logistics',
    lat: 12.97,
    lng: 77.59,
  },
  {
    id: 'site-coastal',
    name: 'Coastal Yard',
    region: 'South',
    entity: 'Beta Foods',
    lat: 13.08,
    lng: 80.27,
  },
  {
    id: 'site-summit',
    name: 'Summit Office',
    region: 'East',
    entity: 'Gamma Services',
    lat: 22.57,
    lng: 88.36,
  },
]

const ACCESS = {
  'demo-admin': { sites: [], regions: [], entities: [] },
  'demo-manager': { sites: [], regions: ['North'], entities: [] },
  'demo-employee': {
    sites: ['site-harbour', 'site-valley'],
    regions: [],
    entities: [],
    modules: ['incidents', 'hira', 'equipment', 'training', 'actions'],
  },
}

export async function seedDemo() {
  const put = (path, id, data) => setDoc(doc(db, path, id), data)
  await put('organization', 'profile', { name: 'Demo Industries', address: 'Sample data only' })

  for (const a of DEMO_ACCOUNTS) {
    await put('users', a.uid, {
      name: a.name,
      email: a.email,
      role: a.role,
      status: 'approved',
      mustChangePassword: false,
      department: a.role === 'member' ? 'Operation' : 'Safety',
      siteId: a.role === 'member' ? 'site-harbour' : '',
      access: ACCESS[a.uid],
    })
  }

  for (const { id, ...s } of SITES) await put('sites', id, { ...s, address: '' })

  const incidents = [
    [
      'inc-1',
      'site-harbour',
      'near_miss',
      'medium',
      'Forklift reversed close to a pedestrian walkway',
      -3,
      'investigation',
    ],
    ['inc-2', 'site-ridge', 'first_aid', 'low', 'Minor cut while opening a carton', -9, 'capa'],
    [
      'inc-3',
      'site-valley',
      'property_damage',
      'high',
      'Racking upright struck by a pallet truck',
      -15,
      'closed',
    ],
    [
      'inc-4',
      'site-summit',
      'near_miss',
      'low',
      'Loose cable across an office corridor',
      -1,
      'reporting',
    ],
    [
      'inc-5',
      'site-coastal',
      'lost_time',
      'high',
      'Slip on a wet loading bay surface',
      -21,
      'capa',
    ],
  ]
  let n = 1
  for (const [id, siteId, type, severity, narrative, ago, lifecycle] of incidents) {
    const site = SITES.find((s) => s.id === siteId)
    await put('incidents', id, {
      refNo: `IRA-2026-${String(n++).padStart(4, '0')}`,
      lifecycle,
      incidentDate: day(ago),
      type,
      severity,
      siteId,
      site: site.name,
      region: site.region,
      entity: site.entity,
      location: site.name,
      narrative,
      createdBy: id === 'inc-1' ? 'demo-employee' : 'demo-manager',
      createdByName: id === 'inc-1' ? 'Eli Employee' : 'Morgan Manager',
      capa:
        lifecycle === 'capa' || lifecycle === 'investigation'
          ? [
              {
                id: `${id}-a1`,
                description: 'Mark and barrier the pedestrian route',
                owner: 'Eli Employee',
                ownerUid: 'demo-employee',
                dueDate: day(ago + 10),
                status: 'open',
              },
            ]
          : [],
      deletedAt: null,
      createdAt: serverTimestamp(),
    })
  }

  let e = 1
  for (const s of SITES) {
    for (const status of [
      'active',
      'active',
      s.id === 'site-ridge' ? 'to_be_refilled' : 'active',
    ]) {
      await put('extinguishers', `ext-${e}`, {
        serialNo: `EXT-${1000 + e}`,
        type: e % 2 ? 'CO2' : 'ABC Powder',
        capacity: e % 2 ? '4.5 kg' : '6 kg',
        siteId: s.id,
        siteName: s.name,
        centerName: s.name,
        region: s.region,
        entity: s.entity,
        dateOfNextRefill: day(e * 20 - 30),
        status,
        physicalDefects: s.id === 'site-valley' && e % 3 === 0 ? ['pressure gauge'] : [],
        deletedAt: null,
      })
      e += 1
    }
  }

  // Courses themselves are written by seedModules, in createCourse's full shape.
  const assignment = (courseId, courseName, category, dueDate) => ({
    courseId,
    courseName,
    category,
    employeeUid: 'demo-employee',
    employeeName: 'Eli Employee',
    dueDate,
    status: 'assigned',
    batchId: 'asn-demo',
    groupMode: 'people',
    groupLabel: 'Individual selection',
    assignedBy: 'demo-manager',
    assignedByName: 'Morgan Manager',
    createdAt: serverTimestamp(),
  })
  await put(
    'trainingAssignments',
    'ta-1',
    assignment('course-fire', 'Fire safety basics', 'Fire Safety', day(5))
  )
  await put(
    'trainingAssignments',
    'ta-2',
    assignment('course-forklift', 'Forklift awareness', 'Induction', day(-2))
  )

  await seedModules(put, { day, sites: SITES })
}
