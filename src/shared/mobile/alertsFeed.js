// The phone's Alerts feed.
//
// There is no alerts collection. A row here is a document the product already
// stores — a defect report, an incident, a committee meeting, a mock drill —
// or a weather reading, assessed in six-hour slots (stack/lib/siteWeather.js).
// A weather row is the current Medium-or-worse picture for a site, keyed to
// its slot. It comes back unread when the slot or the hazard changes.
//
// Scope is the sites the viewer can already see. A record that does not
// resolve to one of those sites is left out: showing it would be another
// site's activity on this phone. Web push (FCM) is not part of this. The
// badge is the unread count while the app is open.
import { DEFECT_BY_KEY } from '../../modules/fire/lib/constants'
import { indexSites, resolveSite } from '../../modules/fire/lib/siteLink'
import { INCIDENT_TYPE_BY_KEY } from '../../modules/incidents/lib/constants'
import { BAND_LABEL, levelOf } from '../../modules/weather/lib/weatherRisk'
import { asOfLabel } from '../../modules/weather/lib/observedAt'

// Same window the digest uses. Kept here because the function package cannot
// be imported by the SPA, and the slot string is the identity of a weather row.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

export const FEED_WINDOW_MS = 45 * 24 * 60 * 60 * 1000
export const FEED_CAP = 60

const ALERT_BANDS = new Set(['moderate', 'high', 'severe'])

const norm = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()

/** `YYYY-MM-DDTHH+0530` with HH at 00, 06, 12 or 18 Asia/Kolkata. */
export function weatherBucket(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const ist = new Date(d.getTime() + IST_OFFSET_MS)
  const hour = Math.floor(ist.getUTCHours() / 6) * 6
  const pad = String(hour).padStart(2, '0')
  const y = ist.getUTCFullYear()
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0')
  const day = String(ist.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}T${pad}+0530`
}

/** Start of that slot, in epoch ms. */
export function bucketStartMs(bucket) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})\+0530$/.exec(bucket || '')
  if (!match) return 0
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4]) - IST_OFFSET_MS
}

export function millisOf(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value.seconds === 'number') return value.seconds * 1000
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

export function parseReadIds(ids) {
  if (typeof ids !== 'string' || !ids) return new Set()
  return new Set(
    ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

/** Comma-joined, capped, in a shape the rules accept. */
export function serializeReadIds(ids) {
  const list = [...ids].filter((id) => /^[A-Za-z0-9:_+-]+$/.test(id)).slice(0, 120)
  return list.join(',')
}

/**
 * Next read-set. Ids that have left the feed are dropped, so the document
 * cannot grow for the life of the organisation. `mark` is one id, or '*'
 * for every row currently on screen.
 */
export function nextReadIds(prev, feedIds, mark) {
  const keep = new Set(feedIds)
  const next = new Set()
  for (const id of prev) if (keep.has(id)) next.add(id)
  if (mark === '*') for (const id of keep) next.add(id)
  else if (mark && keep.has(mark)) next.add(mark)
  return next
}

function inScope(rec, sites) {
  if (!rec) return false
  if (rec.siteId) return sites.some((s) => s.id === rec.siteId)
  return sites.some((s) => {
    const name = norm(s.name)
    if (!name) return false
    return ['location', 'site', 'centerName', 'siteName'].some((field) => {
      const value = norm(rec[field])
      return !!value && (value === name || value.includes(name) || name.includes(value))
    })
  })
}

function assetSiteId(asset, sites, idx) {
  if (!asset || asset.deletedAt) return ''
  if (asset.siteId) return String(asset.siteId)
  return resolveSite(asset.centerName, sites, idx)?.site?.id || ''
}

function defectAsset(report, assets) {
  if (report.kind === 'asset_defect') {
    const list = assets[report.assetKind] || []
    return list.find((row) => row.id === report.assetRefId) || null
  }
  if (report.kind === 'defect') {
    return (assets.extinguishers || []).find((row) => row.id === report.extId) || null
  }
  return null
}

function withinWindow(at, now) {
  return at > 0 && now - at <= FEED_WINDOW_MS && at <= now + 60_000
}

/**
 * @returns rows newest first, each `{ id, kind, title, detail, to, at, unread }`
 */
export function buildAlertFeed({
  now = Date.now(),
  sites = [],
  reports = [],
  assets = {},
  incidents = [],
  meetings = [],
  drills = [],
  weatherBySiteId = {},
  enabled = {},
  readIds = new Set(),
} = {}) {
  const rows = []
  const idx = indexSites(sites)
  const on = (key) => enabled[key] !== false

  if (on('equipment')) {
    for (const report of reports) {
      if (report.kind !== 'defect' && report.kind !== 'asset_defect') continue
      const asset = defectAsset(report, assets)
      const siteId = assetSiteId(asset, sites, idx)
      if (!siteId || !sites.some((s) => s.id === siteId)) continue
      const at = millisOf(report.reportedAt || report.createdAt)
      if (!withinWindow(at, now)) continue
      const what =
        report.kind === 'asset_defect'
          ? report.defect || 'Defect'
          : DEFECT_BY_KEY[report.defectType]?.label || 'Defect'
      const where = report.assetLabel || report.extLabel || asset?.centerName || ''
      rows.push({
        id: `defect:${report.id}`,
        kind: 'Defect',
        title: where ? `${what} · ${where}` : what,
        detail: sites.find((s) => s.id === siteId)?.name || '',
        to: '/equipment/defects',
        at,
      })
    }
  }

  if (on('incidents')) {
    for (const incident of incidents) {
      if (incident.deletedAt) continue
      if (!inScope(incident, sites)) continue
      const at = millisOf(incident.createdAt)
      if (!withinWindow(at, now)) continue
      const known = INCIDENT_TYPE_BY_KEY[incident.type]?.label
      const type =
        known || (typeof incident.type === 'string' && incident.type ? incident.type : 'Incident')
      const ref = incident.refNo ? ` ${incident.refNo}` : ''
      rows.push({
        id: `incident:${incident.id}`,
        kind: 'Incident',
        title: `${type}${ref}`,
        detail: incident.site || incident.location || '',
        to: `/incidents/${incident.id}`,
        at,
      })
    }
  }

  if (on('committee')) {
    for (const meeting of meetings) {
      if (!inScope(meeting, sites)) continue
      const at = millisOf(meeting.createdAt) || millisOf(meeting.date)
      if (!withinWindow(at, now)) continue
      const id = meeting.docKey || meeting.id
      if (!id) continue
      rows.push({
        id: `meeting:${id}`,
        kind: 'Meeting',
        title: meeting.type || 'Committee meeting',
        detail: meeting.date || sites.find((s) => s.id === meeting.siteId)?.name || '',
        to: '/committee',
        at,
      })
    }
  }

  if (on('drills')) {
    for (const drill of drills) {
      if (!inScope(drill, sites)) continue
      const at = millisOf(drill.createdAt) || millisOf(drill.date)
      if (!withinWindow(at, now)) continue
      if (!drill.id) continue
      const where = drill.centerName || ''
      rows.push({
        id: `drill:${drill.id}`,
        kind: 'Drill',
        title: where
          ? `${drill.eventType || 'Mock drill'} · ${where}`
          : drill.eventType || drill.scenario || 'Mock drill',
        detail: drill.scenario || '',
        to: '/mock-drills',
        at,
      })
    }
  }

  if (on('weather')) {
    const bucket = weatherBucket(now)
    const at = bucketStartMs(bucket)
    for (const site of sites) {
      const risk = weatherBySiteId[site.id]
      if (!risk?.hazards) continue
      const hazards = risk.hazards.filter((h) => ALERT_BANDS.has(h.band))
      if (!hazards.length) continue
      const keys = hazards
        .map((h) => h.key)
        .sort()
        .join('+')
      const worst = hazards.reduce(
        (band, h) => (levelOf(h.band) > levelOf(band) ? h.band : band),
        'none'
      )
      const asOf = asOfLabel(risk.observedAt)
      const observedMs = Date.parse(
        typeof risk.observedAt === 'string' && !/Z$|[+-]\d{2}:\d{2}$/.test(risk.observedAt)
          ? `${risk.observedAt}Z`
          : risk.observedAt
      )
      rows.push({
        id: `weather:${site.id}:${risk.slot || bucket}:${keys}`,
        kind: 'Weather',
        title: `${site.name}: ${hazards.map((h) => h.label).join(', ')}`,
        detail: [BAND_LABEL[worst], asOf].filter(Boolean).join(' · '),
        to: '/weather',
        at: Number.isFinite(observedMs) ? observedMs : at,
      })
    }
  }

  rows.sort((a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id)))
  return rows.slice(0, FEED_CAP).map((row) => ({ ...row, unread: !readIds.has(row.id) }))
}

export function unreadCount(rows = []) {
  return rows.reduce((n, row) => n + (row.unread ? 1 : 0), 0)
}
