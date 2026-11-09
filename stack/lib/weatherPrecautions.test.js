import { describe, expect, it } from 'vitest'
import { PRECAUTIONS } from './mailTemplates/lifecycle.js'
import { memoryDb } from '../test-support/memoryDb.js'
import {
  ALERT_KEYS,
  CATALOG,
  GENERIC_PRECAUTIONS,
  activitiesForArea,
  chooseActivities,
  FACILITY_LABELS,
  canonicalFacility,
  resolvePrecaution,
  classifySignal,
  indexSiteSignals,
  loadPrecautionFor,
  normalizeOverrides,
  packOverrides,
  precautionText,
} from './weatherPrecautions.js'

describe('generic precautions', () => {
  it('stays the sentence the mail already sent when no activity is recorded', () => {
    expect(GENERIC_PRECAUTIONS).toEqual(PRECAUTIONS)
    expect(precautionText('heat', [])).toBe(GENERIC_PRECAUTIONS.heat)
    expect(precautionText('heat', [])).toMatch(/cool drinking water/)
    expect(precautionText('rain', [])).toMatch(/electrical/)
    expect(precautionText('heat', [])).not.toMatch(/outdoor classes/i)
  })

  it('never treats UV as an alert', () => {
    expect(ALERT_KEYS).not.toContain('uv')
    for (const entry of CATALOG) {
      expect(entry.precautions.uv).toBeUndefined()
      for (const text of Object.values(entry.precautions)) {
        expect(text).not.toMatch(/sunscreen|uv index/i)
      }
    }
  })
})

describe('catalog', () => {
  it('gives every activity its own heat and rain sentence', () => {
    for (const entry of CATALOG) {
      for (const key of ALERT_KEYS) {
        const text = entry.precautions[key]
        expect(text, `${entry.label} ${key}`).toEqual(expect.any(String))
        expect(text.length, `${entry.label} ${key}`).toBeGreaterThan(40)
        expect(text.length, `${entry.label} ${key}`).toBeLessThanOrEqual(500)
      }
    }
  })

  it('tells a construction yard and a fitness centre different things', () => {
    const construction = precautionText(
      'heat',
      chooseActivities({ orgActivityTypes: ['Construction'] })
    )
    const fitness = precautionText(
      'heat',
      chooseActivities({ orgActivityTypes: ['Fitness & Recreation'] })
    )
    expect(construction).toMatch(/at-height/)
    expect(construction).toMatch(/hot work/i)
    expect(fitness).toMatch(/ventilation/i)
    expect(fitness).toMatch(/hydration/i)
    expect(fitness).not.toMatch(/outdoor class|outdoor session|pitch/i)
    expect(fitness).not.toMatch(/scaffolding/)
    expect(construction).not.toBe(fitness)
    const constructionRain = precautionText(
      'rain',
      chooseActivities({ orgActivityTypes: ['Construction'] })
    )
    const fitnessRain = precautionText(
      'rain',
      chooseActivities({ orgActivityTypes: ['Fitness & Recreation'] })
    )
    expect(constructionRain).toMatch(/scaffolding/)
    expect(fitnessRain).toMatch(/mats/)
    expect(fitnessRain).not.toMatch(/outdoor session|pitch/i)
    expect(constructionRain).not.toBe(fitnessRain)
  })
})

describe('chooseActivities', () => {
  it('uses the organisation list when the site has no record of its own', () => {
    expect(chooseActivities({ orgActivityTypes: ['Construction'] })).toEqual(['construction'])
    expect(chooseActivities({})).toEqual([])
  })

  it('adds a permit task on top of the organisation, and does not repeat a parent', () => {
    expect(
      chooseActivities({
        orgActivityTypes: ['Construction'],
        siteTaskIds: ['hotwork', 'height'],
      })
    ).toEqual(['hotwork', 'height', 'construction'])
    expect(
      chooseActivities({
        orgActivityTypes: ['Utilities & Energy'],
        siteTaskIds: ['electrical'],
      })
    ).toEqual(['electrical'])
    expect(
      chooseActivities({
        orgActivityTypes: ['Food & Beverage'],
        siteProfileIds: ['kitchen'],
      })
    ).toEqual(['kitchen'])
  })

  it('lets a site type replace the organisation profile', () => {
    expect(
      chooseActivities({
        orgActivityTypes: ['Construction'],
        siteProfileIds: ['office'],
      })
    ).toEqual(['office'])
  })

  it('does not read "inspect the site office" as an office', () => {
    expect(classifySignal('Inspect the site office')).toEqual({ profiles: [], tasks: [] })
    expect(classifySignal('Working at height').tasks).toEqual(['height'])
    expect(classifySignal('Hot Work').tasks).toEqual(['hotwork'])
    expect(classifySignal('outdoor sessions').profiles).toEqual(['outdoorGym'])
    expect(classifySignal('outdoor sessions').tasks).toEqual([])
    expect(classifySignal('gym').profiles).toEqual(['indoorGym'])
    expect(classifySignal('Warehouse').profiles).toEqual(['facilityWarehouse'])
    expect(classifySignal('Warehousing & Logistics').profiles).toEqual(['warehousing'])
    expect(classifySignal('Fitness centre').profiles).toEqual(['fitness'])
  })

  it('keeps a custom label the catalog does not know, and prefers an admin sentence', () => {
    const ids = chooseActivities({ orgActivityTypes: ['Server room'] })
    expect(ids).toEqual(['Server room'])
    expect(precautionText('heat', ids)).toBe(GENERIC_PRECAUTIONS.heat)
    const overrides = { 'Server room': { heat: 'Move the shift out of the hot plant room.' } }
    expect(precautionText('heat', ids, overrides)).toBe('Move the shift out of the hot plant room.')
    expect(chooseActivities({ orgActivityTypes: ['Night deliveries'] })).toEqual(['driving'])
  })

  it('stores an edit and drops one that only repeats the built-in sentence', () => {
    const builtIn = CATALOG.find((entry) => entry.id === 'construction').precautions.heat
    const packed = packOverrides({
      Construction: { heat: builtIn, rain: '  Stop the pour.  ' },
      'Server room': { heat: '<script>alert(1)</script>' },
      '  ': { heat: 'nope' },
    })
    expect(packed.Construction.heat).toBeUndefined()
    expect(packed.Construction.rain).toBe('Stop the pour.')
    expect(packed['Server room'].heat).toContain('<script>')
    expect(normalizeOverrides(['nope'])).toEqual({})
  })
})

describe('site records', () => {
  const sites = [
    { id: 'yard', name: 'River Yard', attributes: {} },
    { id: 'office', name: 'Head Office', attributes: { site_type: 'Office' } },
    { id: 'pitch', name: 'Harbour Pitch', attributes: { site_type: 'Fitness centre' } },
  ]

  const index = indexSiteSignals({
    sites,
    assessments: [
      {
        kind: 'baseline',
        siteName: '',
        activities: [{ title: 'Hot work', hazards: [] }],
      },
      {
        siteId: 'yard',
        siteName: 'River Yard',
        activities: [
          {
            title: 'Inspect the site office',
            hazards: [{ hazardType: 'Working at height', hazardCategory: 'Gravity Access' }],
          },
        ],
      },
      {
        siteId: 'pitch',
        siteName: 'Harbour Pitch',
        activities: [{ title: 'Outdoor sessions', hazards: [] }],
      },
    ],
    permits: [
      { site: 'River Yard', typeOfWork: 'Hot Work', hazards: ['Live Electrical'] },
      { siteId: 'office', site: 'Head Office', typeOfWork: 'Electrical Work' },
    ],
  })

  it('mixes the organisation profile with the work recorded at that site', () => {
    const org = { activityTypes: ['Construction'] }
    expect(activitiesForArea(org, index, { siteId: 'yard', name: 'River Yard' })).toEqual([
      'hotwork',
      'height',
      'electrical',
      'construction',
    ])
    expect(activitiesForArea(org, index, { siteId: 'office', name: 'Head Office' })).toEqual([
      'electrical',
      'office',
    ])
    const pitch = activitiesForArea({ activityTypes: ['Fitness & Recreation'] }, index, {
      siteId: 'pitch',
      name: 'Harbour Pitch',
    })
    expect(pitch).toEqual(['outdoorGym'])
    const yardHeat = precautionText(
      'heat',
      activitiesForArea(org, index, { siteId: 'yard', name: 'River Yard' })
    )
    const officeHeat = precautionText(
      'heat',
      activitiesForArea(org, index, { siteId: 'office', name: 'Head Office' })
    )
    expect(yardHeat).toMatch(/Hot work:/)
    expect(yardHeat).toMatch(/Construction:/)
    expect(officeHeat).toMatch(/cooled rooms/)
    expect(officeHeat).not.toMatch(/scaffolding/)
  })

  it('uses the facility tag on a fitness estate, and does not mention outdoor classes', () => {
    const org = { activityTypes: ['Fitness & Recreation'] }
    const sites = [
      { id: 'gym', name: 'North Studio', facility: 'Indoor gym' },
      { id: 'pool', name: 'Lane Pool', facility: 'Indoor pool' },
      { id: 'court', name: 'Court Hall', facility: 'Indoor court' },
      { id: 'wh', name: 'Dock Store', facility: 'Warehouse' },
      { id: 'bare', name: 'Reception' },
    ]
    const index = indexSiteSignals({ sites })
    const text = (alert, id, name) =>
      precautionText(alert, activitiesForArea(org, index, { siteId: id, name }))
    expect(text('heat', 'gym', 'North Studio')).toMatch(/high-intensity/i)
    expect(text('heat', 'gym', 'North Studio')).toMatch(/hydration/i)
    expect(text('heat', 'pool', 'Lane Pool')).toMatch(/chlorine/i)
    expect(text('heat', 'pool', 'Lane Pool')).toMatch(/plant-room/i)
    expect(text('heat', 'court', 'Court Hall')).toMatch(/courts/i)
    expect(text('heat', 'wh', 'Dock Store')).toMatch(/forklift/i)
    expect(text('heat', 'wh', 'Dock Store')).toMatch(/loading bay/i)
    expect(text('heat', 'bare', 'Reception')).toMatch(/ventilation/i)
    expect(text('rain', 'pool', 'Lane Pool')).toMatch(/pool deck/i)
    expect(text('rain', 'wh', 'Dock Store')).toMatch(/stock/)
    expect(text('rain', 'wh', 'Dock Store')).toMatch(/forklift/i)
    expect(text('lightning', 'pool', 'Lane Pool')).toMatch(/evacuate the pool/i)
    expect(text('lightning', 'pool', 'Lane Pool')).toMatch(/skylight/i)
    for (const site of sites) {
      expect(text('heat', site.id, site.name)).not.toMatch(/outdoor class|outdoor session|pitch/i)
      expect(text('rain', site.id, site.name)).not.toMatch(/outdoor class|outdoor session|pitch/i)
    }
    expect(FACILITY_LABELS).toEqual(
      expect.arrayContaining(['Office', 'Indoor gym', 'Kitchen/Cafeteria', 'Other'])
    )
    expect(canonicalFacility('gym')).toBe('Indoor gym')
    expect(canonicalFacility('office')).toBe('Office')
    expect(canonicalFacility('Kitchen/Cafeteria')).toBe('Kitchen/Cafeteria')
    expect(canonicalFacility('Cold store', ['Cold store'])).toBe('Cold store')
  })

  it('frames the mail from the site type, then the organisation, then the general paragraph', () => {
    const org = { activityTypes: ['Fitness & Recreation'] }
    const sites = [
      { id: 'office', name: 'Head Office', facility: 'Office' },
      { id: 'yard', name: 'River Yard', facility: 'Outdoor site/Construction' },
      { id: 'other', name: 'Reception', facility: 'Other' },
      { id: 'cold', name: 'Cold Store', facility: 'Cold store' },
      { id: 'bare', name: 'Unset' },
    ]
    const index = indexSiteSignals({ sites })
    const text = (id, name, overrides) =>
      resolvePrecaution('heat', org, index, { siteId: id, name }, overrides)
    expect(text('office', 'Head Office')).toMatch(/cooled rooms/)
    expect(text('office', 'Head Office')).not.toMatch(/outdoor class|hydration stations/i)
    expect(text('yard', 'River Yard')).toMatch(/at-height/)
    expect(text('other', 'Reception')).toMatch(/hydration/i)
    expect(text('bare', 'Unset')).toMatch(/hydration/i)
    expect(text('cold', 'Cold Store')).toMatch(/hydration/i)
    expect(
      text('cold', 'Cold Store', { 'Cold store': { heat: 'Limit time in the chiller.' } })
    ).toBe('Limit time in the chiller.')
    expect(text('other', 'Reception', { Other: { heat: 'Follow the duty manager’s note.' } })).toBe(
      'Follow the duty manager’s note.'
    )
  })
})

describe('loadPrecautionFor', () => {
  it('reads the org, the permit and the assessment, and still mails if that read fails', async () => {
    const db = memoryDb({
      'organizations/orgA': {
        activityTypes: ['Construction'],
        weatherPrecautions: { Construction: { heat: 'Custom shade rule for the yard.' } },
      },
      'organizations/orgA/sites/yard': { name: 'River Yard' },
      'organizations/orgA/permits/p1': {
        siteId: 'yard',
        site: 'River Yard',
        typeOfWork: 'Hot Work',
      },
      'organizations/orgA/assessments/a1': {
        siteId: 'yard',
        siteName: 'River Yard',
        activities: [{ title: 'Roof work', hazards: [{ hazardType: 'Working at height' }] }],
      },
    })
    const sites = [{ id: 'yard', name: 'River Yard' }]
    const textFor = await loadPrecautionFor(db, 'orgA', sites, { error() {}, info() {} })
    const heat = textFor('heat', { siteId: 'yard', name: 'River Yard' })
    expect(heat).toMatch(/Hot work:/)
    expect(heat).toMatch(/Working at height:/)
    expect(heat).toMatch(/Custom shade rule/)
    expect(heat).not.toMatch(/cool drinking water/)

    const broken = memoryDb({ 'organizations/orgA': { activityTypes: ['Fitness & Recreation'] } })
    const original = broken.collection
    broken.collection = (name) => {
      if (name.endsWith('/assessments') || name.endsWith('/permits')) {
        return {
          select() {
            return this
          },
          limit() {
            return this
          },
          get: async () => {
            throw new Error('index missing')
          },
        }
      }
      return original(name)
    }
    const logged = []
    const fallback = await loadPrecautionFor(broken, 'orgA', [], {
      error: (...args) => logged.push(args),
      info() {},
    })
    expect(fallback('heat', { name: 'Clubhouse' })).toMatch(/hydration/i)
    expect(fallback('heat', { name: 'Clubhouse' })).not.toMatch(/outdoor class/i)
    expect(logged.length).toBe(1)
  })
})
