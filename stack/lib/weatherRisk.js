// ─────────────────────────────────────────────────────────────────────────────
// Weather as an occupational hazard, not a forecast.
//
// A site page showing "24°C, light rain" tells a safety officer nothing they
// could act on. What matters is whether today's conditions put a control at
// risk: heat stress, cold stress, rain, lightning and air quality. So this
// maps raw observations onto the same five-band scale the rest of the app
// uses for risk, and names the work that each band affects.
//
// Wind, visibility, UV, freezing rain and snow are not hazards here. A field
// for one of them on an observation does not produce a row.
//
// One copy for both sides: the app re-exports it (src/modules/weather/lib/
// weatherRisk.js) and the server's six-hourly weather notification reads it
// (stack/lib/notifySchedule.js), so a cut-off moves in one place.
//
// Pure — no network, no clock. `assessWeather` takes an already-normalised
// observation so the thresholds can be tested directly.
// ─────────────────────────────────────────────────────────────────────────────

/** Ordered worst-last, so a band's index is its severity. */
export const BANDS = ['none', 'low', 'moderate', 'high', 'severe']

export const BAND_LABEL = {
  none: 'No weather risk',
  low: 'Be aware',
  moderate: 'Take precautions',
  high: 'Restrict work',
  severe: 'Stop outdoor work',
}

/**
 * Pick a band from ascending cut-offs: `band(v, [a, b, c, d])` is `low` once v
 * reaches a, `severe` once it reaches d. Below a it is `none`.
 */
function band(value, cuts) {
  let i = 0
  while (i < cuts.length && value >= cuts[i]) i += 1
  return BANDS[i]
}

/** Same, for scales that get worse as the number falls (cold). */
function bandDescending(value, cuts) {
  let i = 0
  while (i < cuts.length && value <= cuts[i]) i += 1
  return BANDS[i]
}

export const levelOf = (b) => BANDS.indexOf(b)

const round = (n) => Math.round(n)

// Heat is only reported from 40°C up.
//
// The published NWS caution band starts at 27°C, which is an ordinary working
// day across most of this org's sites — flagging it meant the heat row was
// permanently lit and stopped carrying information. Starting at 40 keeps the
// warning for days that genuinely need water, shade and rest breaks scheduled,
// and the upper bands still line up with the NWS danger figures.
//
// Read against apparent temperature, because humidity is what defeats sweating
// and a crew in PPE feels that figure rather than the dry-bulb one.
const HEAT_CUTS = [40, 45, 51, 56]

// High needs a hot AIR, not just a hot feel. Feels-like still sets Low and
// Medium, but a feels-like that would be High (or severe) while the air
// temperature is at or below 40°C is capped at Medium. Strictly above: 40.0 is
// not High, 40.1 is. A reading with no air temperature cannot show the air is
// above 40, so it is capped too. Keep in step with stack/lib/weatherBands.js.
const HEAT_HIGH_MIN_AIR_C = 40

function heatBand(feels, airC) {
  const b = band(feels, HEAT_CUTS)
  if (levelOf(b) >= levelOf('high') && !(airC != null && airC > HEAT_HIGH_MIN_AIR_C)) {
    return 'moderate'
  }
  return b
}

// Feels-like °C, worse as it falls.
// ≤ 10°C low, ≤ 0°C Medium, ≤ -10°C High, ≤ -25°C severe. 10°C is the usual
// cold-stress awareness line; freezing is the mailed Medium line.
const COLD_CUTS = [10, 0, -10, -25]

// Rain rate, mm/h. Above 10 mm/h drainage stops keeping up and yards flood;
// above 30 is a cloudburst. Open-Meteo hourly precipitation is already the
// preceding hour in mm, so these cuts see that figure directly.
const RAIN_CUTS = [0.5, 4, 10, 30]

// Rain is reported as a named alert rather than only a band, because "medium
// rain alert" is what gets said on a site call and "moderate weather risk" is
// not. The two scales stay tied: the alert is the band in the words people use,
// so a cloudburst reads High and still drives the severe overall verdict.
export const RAIN_ALERT = {
  low: 'Low',
  moderate: 'Medium',
  high: 'High',
  severe: 'High',
}

// CAPE in J/kg, used when the forecast has no thunderstorm code.
// Below 1000 is not an alert. 1000–2500 is Medium. 2500 and above is High.
// A code of 95, 96 or 99 is a thunderstorm (99 is heavy hail) and is severe
// on its own. Keep in step with stack/lib/weatherBands.js.
const CAPE_MEDIUM = 1000
const CAPE_HIGH = 2500

// AQI, 0–500. Below 200 is Low. 200 up to 400 is Medium. 400 and above is
// High — including 500, which is the top of the scale rather than a separate cut.
const AQI_MEDIUM = 200
const AQI_HIGH = 400

const LEVEL_WORD = { low: 'Low', moderate: 'Medium', high: 'High', severe: 'High' }

function thunderstorm(code) {
  return code === 95 || code === 96 || code === 99
}

function lightningBand(code, cape) {
  if (thunderstorm(code)) return 'severe'
  if (cape == null) return 'none'
  if (cape >= CAPE_HIGH) return 'high'
  if (cape >= CAPE_MEDIUM) return 'moderate'
  return 'none'
}

function lightningValue(code, cape) {
  const parts = []
  if (thunderstorm(code)) parts.push('Thunderstorm forecast')
  if (cape != null) parts.push(`CAPE ${round(cape)} J/kg`)
  return parts.join(' · ')
}

function airBand(aqi) {
  if (aqi >= AQI_HIGH) return 'high'
  if (aqi >= AQI_MEDIUM) return 'moderate'
  return 'low'
}

/**
 * Assess one observation.
 *
 * `obs` fields are all optional — a provider that cannot supply air quality
 * should simply omit it rather than send a zero, which would read as Low.
 *
 * Returns the overall band plus every hazard that reached at least `low`,
 * worst first. Hazards sitting at `none` are dropped.
 */
export function assessWeather(obs = {}) {
  const { apparentTempC, tempC, precipMmHr, capeJkg, lightningCode, aqi, aqiSource } = obs

  const hazards = []
  const add = (h) => {
    if (levelOf(h.band) > 0) hazards.push(h)
  }

  const feels = num(apparentTempC) ?? num(tempC)
  if (feels != null) {
    add({
      key: 'heat',
      label: 'Heat stress',
      band: heatBand(feels, num(tempC)),
      value: `Feels like ${round(feels)}°C`,
      affects: 'Outdoor and PPE-heavy work — schedule rest breaks, water and shade.',
    })
    add({
      key: 'cold',
      label: 'Cold stress',
      band: bandDescending(feels, COLD_CUTS),
      value: `Feels like ${round(feels)}°C`,
      affects: 'Exposed skin and grip — warm-up breaks and insulated gloves.',
    })
  }

  const rain = num(precipMmHr)
  if (rain != null) {
    const rainBand = band(rain, RAIN_CUTS)
    add({
      key: 'rain',
      label: 'Rain alert',
      band: rainBand,
      alert: RAIN_ALERT[rainBand] || null,
      value: `${RAIN_ALERT[rainBand] || ''} · ${rain.toFixed(1)} mm/h`.replace(/^ · /, ''),
      affects: 'Slips, excavations, electrical work and site vehicle stopping distance.',
    })
  }

  const code = num(lightningCode)
  const cape = num(capeJkg)
  const storm = lightningBand(code, cape)
  if (storm !== 'none') {
    add({
      key: 'lightning',
      label: 'Lightning',
      band: storm,
      value: lightningValue(code, cape),
      affects: 'Stop work at height, hot work, cranes and open-air electrical work.',
    })
  }

  const index = num(aqi)
  if (index != null && index >= 0) {
    const bandName = airBand(index)
    const via = aqiSource === 'pm' ? ' (particles)' : ''
    add({
      key: 'air',
      label: 'Air quality',
      band: bandName,
      value: `${LEVEL_WORD[bandName]} · AQI ${round(index)}${via}`,
      affects: 'Heavy outdoor work — move people indoors and slow strenuous tasks.',
    })
  }

  hazards.sort((a, b) => levelOf(b.band) - levelOf(a.band))
  const level = hazards.length ? levelOf(hazards[0].band) : 0

  return { level, band: BANDS[level], hazards }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Roll several sites' assessments into one list of what kinds of weather are a
 * problem, and how widely.
 *
 * The single worst hazard answers "how bad is it" but not "what is it" — three
 * sites in heavy rain and one under a thunderstorm is a different morning from
 * four sites baking. So each category present is reported once, at its worst
 * band, with the number of sites showing it.
 *
 * @param risks assessments (the result of assessWeather), one per site
 * @returns [{ key, label, band, level, sites }] worst first, then most sites
 */
export function summariseHazards(risks = []) {
  const byKey = new Map()
  for (const r of risks) {
    if (!r?.hazards) continue
    // A site cannot count twice for the same category, however many readings
    // produced it.
    const seen = new Set()
    for (const h of r.hazards) {
      if (seen.has(h.key)) continue
      seen.add(h.key)
      const cur = byKey.get(h.key)
      if (!cur) byKey.set(h.key, { key: h.key, label: h.label, band: h.band, sites: 1 })
      else {
        cur.sites += 1
        if (levelOf(h.band) > levelOf(cur.band)) cur.band = h.band
      }
    }
  }
  return [...byKey.values()]
    .map((h) => ({ ...h, level: levelOf(h.band) }))
    .sort((a, b) => b.level - a.level || b.sites - a.sites || a.label.localeCompare(b.label))
}
