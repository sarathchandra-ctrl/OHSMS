import { describe, expect, it } from 'vitest'
import {
  buildAlertFeed,
  bucketStartMs,
  nextReadIds,
  parseReadIds,
  serializeReadIds,
  unreadCount,
  weatherBucket,
} from './alertsFeed'

const NOW = Date.parse('2026-10-24T10:00:00Z')
const SITES = [
  { id: 's1', name: 'North Plant' },
  { id: 's2', name: 'South Yard' },
]

const recent = (msAgo) => ({ seconds: Math.floor((NOW - msAgo) / 1000) })

function feed(over = {}) {
  return buildAlertFeed({ now: NOW, sites: [SITES[0]], ...over })
}

describe('weather slot', () => {
  it('buckets on the Asia/Kolkata six-hour boundary the digest uses', () => {
    expect(weatherBucket(NOW)).toBe('2026-10-24T12+0530')
    expect(bucketStartMs('2026-10-24T12+0530')).toBe(Date.parse('2026-10-24T06:30:00Z'))
  })
})

describe('buildAlertFeed', () => {
  it('lists in-scope defects, incidents, meetings, drills and elevated weather, newest first', () => {
    const rows = feed({
      reports: [
        {
          id: 'r1',
          kind: 'defect',
          defectType: 'pin',
          extId: 'e1',
          extLabel: 'EXT-1',
          reportedAt: recent(60_000),
        },
        {
          id: 'r2',
          kind: 'defect',
          defectType: 'pin',
          extId: 'e2',
          extLabel: 'EXT-2',
          reportedAt: recent(30_000),
        },
        { id: 'r3', kind: 'status_change', extId: 'e1', reportedAt: recent(10_000) },
      ],
      assets: {
        extinguishers: [
          { id: 'e1', siteId: 's1', centerName: 'North Plant' },
          { id: 'e2', siteId: 's2', centerName: 'South Yard' },
        ],
      },
      incidents: [
        { id: 'i1', siteId: 's1', type: 'near_miss', refNo: 'IRA-9', createdAt: recent(120_000) },
        { id: 'i2', siteId: 's2', type: 'near_miss', refNo: 'IRA-8', createdAt: recent(10_000) },
        {
          id: 'i3',
          siteId: 's1',
          type: 'near_miss',
          deletedAt: recent(10_000),
          createdAt: recent(10_000),
        },
      ],
      meetings: [
        {
          docKey: 'm1',
          siteId: 's1',
          type: 'HSE Committee Meeting',
          date: '2026-10-24',
          createdAt: recent(3_600_000),
        },
      ],
      drills: [
        {
          id: 'd1',
          centerName: 'North Plant',
          eventType: 'Fire',
          scenario: 'Evacuation',
          createdAt: recent(7_200_000),
        },
      ],
      weatherBySiteId: {
        s1: {
          hazards: [
            { key: 'heat', label: 'Heat stress', band: 'high' },
            { key: 'wind', label: 'Wind', band: 'low' },
          ],
        },
        s2: { hazards: [{ key: 'rain', label: 'Rain', band: 'severe' }] },
      },
    })

    expect(rows.map((r) => r.id)).toEqual([
      'defect:r1',
      'incident:i1',
      'meeting:m1',
      'drill:d1',
      `weather:s1:2026-10-24T12+0530:heat`,
    ])
    expect(rows[0].title).toBe('PIN · EXT-1')
    expect(rows[1].title).toBe('Near Miss IRA-9')
    expect(rows[1].to).toBe('/incidents/i1')
    expect(rows.every((r) => r.unread)).toBe(true)
    expect(rows.find((r) => r.kind === 'Weather').detail).toBe('Restrict work')
  })

  it('uses the reading time, not the slot start, for a weather row', () => {
    const rows = feed({
      weatherBySiteId: {
        s1: {
          hazards: [{ key: 'heat', label: 'Heat stress', band: 'high' }],
          observedAt: '2026-10-24T06:30:00.000Z',
          slot: '2026-10-24T12+0530',
        },
      },
    })
    const weather = rows.find((r) => r.kind === 'Weather')
    expect(weather.detail).toBe('Restrict work · As of 24 Oct, 12:00 IST')
    expect(weather.at).toBe(Date.parse('2026-10-24T06:30:00.000Z'))
    expect(weather.id).toContain('2026-10-24T12+0530')
  })

  it('hides a record with no site, and a module that is switched off', () => {
    const rows = feed({
      enabled: { incidents: false, weather: false },
      reports: [
        {
          id: 'r1',
          kind: 'defect',
          defectType: 'empty',
          extId: 'missing',
          reportedAt: recent(1000),
        },
      ],
      incidents: [{ id: 'i1', siteId: 's1', type: 'near_miss', createdAt: recent(1000) }],
      weatherBySiteId: { s1: { hazards: [{ key: 'heat', label: 'Heat stress', band: 'severe' }] } },
    })
    expect(rows).toEqual([])
  })

  it('drops anything older than the window and marks ids already read', () => {
    const old = { seconds: Math.floor((NOW - 50 * 24 * 60 * 60 * 1000) / 1000) }
    const rows = feed({
      readIds: new Set(['incident:i1']),
      incidents: [
        { id: 'i1', siteId: 's1', type: 'first_aid', createdAt: recent(1000) },
        { id: 'i2', siteId: 's1', type: 'first_aid', createdAt: old },
      ],
      enabled: { equipment: false, committee: false, drills: false, weather: false },
    })
    expect(rows.map((r) => r.id)).toEqual(['incident:i1'])
    expect(rows[0].unread).toBe(false)
    expect(unreadCount(rows)).toBe(0)
  })

  it('matches a drill written against the site name when it has no site id', () => {
    const rows = feed({
      enabled: { equipment: false, incidents: false, committee: false, weather: false },
      drills: [{ id: 'd1', centerName: 'North Plant', eventType: 'Fire', createdAt: recent(1000) }],
    })
    expect(rows).toHaveLength(1)
  })
})

describe('read ids', () => {
  it('round-trips a bounded set and forgets ids that have left the feed', () => {
    const prev = parseReadIds('defect:old,incident:i1')
    const next = nextReadIds(prev, ['incident:i1', 'defect:r1'], 'defect:r1')
    expect(serializeReadIds(next)).toBe('incident:i1,defect:r1')
    expect(serializeReadIds(nextReadIds(next, ['incident:i1', 'defect:r1'], '*'))).toBe(
      'incident:i1,defect:r1'
    )
  })

  it('refuses a mark for an id that is not on the feed', () => {
    expect([...nextReadIds(new Set(), ['incident:i1'], 'incident:nope')]).toEqual([])
  })
})
