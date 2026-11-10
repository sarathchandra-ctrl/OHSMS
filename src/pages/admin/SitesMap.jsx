import { useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Tooltip, Popup, useMap } from 'react-leaflet'
import MarkerClusterGroup from '../../shared/map/MarkerClusterGroup'
import L from 'leaflet'
import { MapPin } from 'lucide-react'
import { WeatherBubbleRow, WeatherRiskPanel } from '../../modules/weather/components/WeatherPanels'

// Distinct, map-legible colours cycled across entities.
const PALETTE = [
  '#0d9488',
  '#dc2626',
  '#2563eb',
  '#d97706',
  '#7c3aed',
  '#059669',
  '#db2777',
  '#0891b2',
  '#ca8a04',
  '#4f46e5',
  '#e11d48',
  '#65a30d',
]
const NO_ENTITY = '#64748b'

// Coloured teal/… pin as an HTML divIcon, cached per colour so 100s of
// markers reuse a handful of icon instances.
const iconCache = {}
function pinIcon(color) {
  if (!iconCache[color]) {
    iconCache[color] = L.divIcon({
      className: '',
      html: `<div style="transform:translate(-50%,-100%)">
        <svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">
          <path d="M15 0C6.7 0 0 6.7 0 15c0 10 15 25 15 25s15-15 15-25C30 6.7 23.3 0 15 0z" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>
          <circle cx="15" cy="15" r="5.5" fill="#fff"/>
        </svg></div>`,
      iconSize: [30, 40],
      iconAnchor: [15, 40],
    })
  }
  return iconCache[color]
}

function FitBounds({ points }) {
  const map = useMap()
  useMemo(() => {
    if (points.length === 0) return
    if (points.length === 1) map.setView(points[0], 12)
    else map.fitBounds(points, { padding: [40, 40], maxZoom: 13 })
  }, [points, map])
  return null
}

// Clay-styled cluster badge sized by child count.
function createClusterIcon(cluster) {
  const count = cluster.getChildCount()
  const size = count < 10 ? 34 : count < 100 ? 42 : 50
  return L.divIcon({
    className: '',
    html: `<div class="site-cluster" style="width:${size}px;height:${size}px">${count}</div>`,
    iconSize: [size, size],
  })
}

const Dot = ({ color }) => (
  <span
    style={{
      display: 'inline-block',
      width: 9,
      height: 9,
      borderRadius: '50%',
      background: color,
      marginRight: 6,
      verticalAlign: 'middle',
    }}
  />
)

// How close the bubble may come to the edge of the map before it is pushed back.
const EDGE_PAD = 10

/**
 * Keep the hover bubble fully inside the map.
 *
 * Leaflet's `direction: 'auto'` only picks left or right from which half of the
 * map the pin sits in. It never flips vertically and never clamps to the
 * container, and the tooltip pane is clipped by the map's overflow — so a pin
 * near the top or a side edge showed a bubble with its stats cut off.
 *
 * Measuring after the tooltip opens is what makes this exact: the bubble's
 * height depends on whether the site has an address and live stats, so it
 * cannot be predicted from the data alone.
 */
function fitBubble(map, e) {
  const tip = e.tooltip
  const el = tip?._container
  if (!el) return

  // Measure the natural position, not wherever the last hover left it.
  el.style.marginLeft = '0px'
  el.style.marginTop = '0px'
  el.classList.remove('site-bubble--shifted')

  const frame = map.getContainer().getBoundingClientRect()
  const pin = map.latLngToContainerPoint(e.target.getLatLng())

  // Flip below the pin when there is no room above it, rather than letting the
  // bubble run off the top and hide the very stats it exists to show.
  const wanted = pin.y - el.offsetHeight - 24 < EDGE_PAD ? 'bottom' : 'top'
  if (tip.options.direction !== wanted) {
    tip.options.direction = wanted
    tip.update()
  }

  // Then slide it back inside horizontally and vertically. Margins are used
  // rather than transforms because Leaflet owns the element's transform.
  const box = el.getBoundingClientRect()
  let dx = 0
  let dy = 0
  if (box.left < frame.left + EDGE_PAD) dx = frame.left + EDGE_PAD - box.left
  else if (box.right > frame.right - EDGE_PAD) dx = frame.right - EDGE_PAD - box.right
  if (box.top < frame.top + EDGE_PAD) dy = frame.top + EDGE_PAD - box.top
  else if (box.bottom > frame.bottom - EDGE_PAD) dy = frame.bottom - EDGE_PAD - box.bottom
  if (dx) el.style.marginLeft = `${dx}px`
  if (dy) el.style.marginTop = `${dy}px`

  // The arrow points at the pin. Once the bubble has slid sideways it no longer
  // does, so drop it instead of leaving it aimed at empty space.
  if (Math.abs(dx) > 8) el.classList.add('site-bubble--shifted')
}

/**
 * A pin whose hover bubble is re-fitted to the map each time it opens, and
 * which reports when it has been opened at all.
 *
 * That second job is what keeps the weather lookup affordable: `render` gives
 * children an `opened` flag that stays false until the pin is first hovered or
 * clicked, so a map of two hundred sites makes no weather requests until
 * someone actually looks at one, and none again for the rest of the session.
 */
function SiteMarker({ render, ...props }) {
  const map = useMap()
  const [opened, setOpened] = useState(false)
  return (
    <Marker
      {...props}
      eventHandlers={{
        tooltipopen: (e) => {
          setOpened(true)
          fitBubble(map, e)
        },
        popupopen: () => setOpened(true),
      }}
    >
      {render(opened)}
    </Marker>
  )
}

export default function SitesMap({ sites, stats = {}, onSelect, onEdit, onDelete, canManage }) {
  const located = sites.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
  const points = located.map((s) => [s.lat, s.lng])
  const center = points[0] || [20, 0]

  // Entity → colour mapping (drives pins + legend).
  const entities = useMemo(
    () => [...new Set(located.map((s) => s.entity).filter(Boolean))].sort(),
    [located]
  )
  const colorOf = (entity) =>
    entity ? PALETTE[entities.indexOf(entity) % PALETTE.length] : NO_ENTITY
  const hasUnassigned = located.some((s) => !s.entity)

  if (located.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-3 p-10 text-center">
        <span className="ring-1 ring-ink-200 grid h-14 w-14 place-items-center rounded-2xl bg-surface-100 text-ink-400">
          <MapPin size={26} />
        </span>
        <div>
          <h3 className="font-semibold text-ink-800">No mapped sites yet</h3>
          <p className="mt-1 text-sm text-ink-500">
            Add latitude &amp; longitude to a site to see it on the map.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="card relative overflow-hidden p-0">
      <MapContainer
        center={center}
        zoom={5}
        scrollWheelZoom
        style={{ height: '65vh', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        <MarkerClusterGroup
          chunkedLoading
          maxClusterRadius={55}
          showCoverageOnHover={false}
          spiderfyOnMaxZoom
          iconCreateFunction={createClusterIcon}
        >
          {located.map((s) => {
            const st = stats[s.id]
            const color = colorOf(s.entity)
            return (
              <SiteMarker
                key={s.id}
                position={[s.lat, s.lng]}
                icon={pinIcon(color)}
                render={(opened) => (
                  <>
                    {/* Anchored to the pin rather than sticky to the cursor: a bubble
                      this tall has to be measured and clamped to stay fully visible,
                      and one that re-flows under a moving cursor cannot settle. */}
                    <Tooltip direction="top" offset={[0, -6]} opacity={1} className="site-bubble">
                      <div className="site-bubble-card">
                        <div className="site-bubble-title">
                          <Dot color={color} />
                          {s.name}
                        </div>
                        <div className="site-bubble-sub">
                          {[s.region, s.entity].filter(Boolean).join(' · ') || '—'}
                        </div>
                        {s.address && <div className="site-bubble-addr">{s.address}</div>}
                        {st && (
                          <div className="site-bubble-stats">
                            <span>
                              🧯 Extinguishers <b>{st.extinguishers}</b>
                            </span>
                            <span>
                              ❤️ AED <b>{st.aeds}</b>
                            </span>
                            <span>
                              🔔 Fire alarm <b>{st.fas}</b>
                            </span>
                            <span>
                              🩹 First aid <b>{st.firstAidBoxes}</b>
                            </span>
                            <span>
                              ⚠️ Incidents <b>{st.incidentsTotal}</b>
                            </span>
                            <span>
                              ✅ Open actions <b>{st.openActions}</b>
                            </span>
                            <span>
                              👤 Employees <b>{st.employees.length}</b>
                            </span>
                          </div>
                        )}
                        <WeatherBubbleRow lat={s.lat} lng={s.lng} active={opened} />
                        <div className="site-bubble-hint">Click the pin for actions</div>
                      </div>
                    </Tooltip>

                    <Popup>
                      <div style={{ minWidth: 170, maxWidth: 250 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>
                          <Dot color={color} />
                          {s.name}
                        </div>
                        <div style={{ fontSize: 11, color: '#64748b' }}>
                          {[s.region, s.entity].filter(Boolean).join(' · ') || '—'}
                        </div>
                        {s.address && (
                          <div style={{ fontSize: 11, color: '#94a3b8' }}>{s.address}</div>
                        )}
                        <WeatherRiskPanel lat={s.lat} lng={s.lng} active={opened} />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            onClick={() => onSelect?.(s)}
                            className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:brightness-110"
                          >
                            Summary
                          </button>
                          {canManage && (
                            <button
                              onClick={() => onEdit?.(s)}
                              className="rounded-lg bg-surface-100 px-2.5 py-1 text-xs font-semibold text-ink-700 hover:bg-surface-200"
                            >
                              Edit
                            </button>
                          )}
                          {canManage && (
                            <button
                              onClick={() => onDelete?.(s)}
                              className="rounded-lg bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-100"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </Popup>
                  </>
                )}
              />
            )
          })}
        </MarkerClusterGroup>
      </MapContainer>

      {/* Entity colour legend */}
      {(entities.length > 0 || hasUnassigned) && (
        <div className="absolute right-3 top-3 z-[1000] max-h-[60%] w-44 overflow-auto rounded-2xl bg-white/95 p-3 shadow-lg backdrop-blur">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-400">
            Entity
          </p>
          <ul className="space-y-1">
            {entities.map((e) => (
              <li key={e} className="flex items-center gap-2 text-xs text-ink-700">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: colorOf(e) }}
                />
                <span className="truncate">{e}</span>
              </li>
            ))}
            {hasUnassigned && (
              <li className="flex items-center gap-2 text-xs text-ink-500">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: NO_ENTITY }} />
                <span className="truncate italic">Unassigned</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
