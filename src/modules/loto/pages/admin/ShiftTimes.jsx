import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { subscribeSites } from '../../../../shared/org/orgData'
import { useAuth } from '../../context/AuthContext'
import { SHIFT_PRESETS } from '../../constants/permits'
import { parseClock, shiftsForSite, zoneForSite } from '../../utils/shiftWindow'
import { saveSiteShifts, subscribeShiftSettings } from '../../services/shiftSettings'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Input from '../../components/ui/Input'
import Button from '../../components/ui/Button'
import Spinner from '../../components/ui/Spinner'

const blank = () => ({ id: '', label: '', start: '06:00', end: '14:00' })

function rowsFrom(settings, siteId) {
  return shiftsForSite(settings, siteId).map((s) => ({
    id: s.id,
    label: s.label,
    start: s.start,
    end: s.end,
  }))
}

export default function ShiftTimes() {
  const { profile, platformRole } = useAuth()
  const isAdmin = platformRole === 'admin'
  const [sites, setSites] = useState([])
  const [settings, setSettings] = useState(null)
  const [siteId, setSiteId] = useState('')
  const [rows, setRows] = useState([])
  const [zone, setZone] = useState(0)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    return subscribeSites(setSites)
  }, [])

  useEffect(() => {
    return subscribeShiftSettings((doc) => {
      setSettings(doc)
      setReady(true)
    })
  }, [])

  useEffect(() => {
    if (!siteId && sites[0]?.id) setSiteId(sites[0].id)
  }, [sites, siteId])

  useEffect(() => {
    if (!siteId) return
    setRows(rowsFrom(settings, siteId))
    const saved = zoneForSite(settings, siteId)
    setZone(saved == null ? -new Date().getTimezoneOffset() : saved)
  }, [siteId, settings])

  const siteName = useMemo(
    () => sites.find((s) => s.id === siteId)?.name || siteId,
    [sites, siteId],
  )

  function setRow(i, patch) {
    setRows((list) => list.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  }

  async function onSave(e) {
    e.preventDefault()
    if (!isAdmin) return
    const cleaned = rows
      .map((r) => ({ ...r, id: r.id.trim(), label: r.label.trim() || r.id.trim() }))
      .filter((r) => r.id)
    if (!cleaned.length) return toast.error('Add at least one shift')
    if (cleaned.some((r) => !parseClock(r.start) || !parseClock(r.end))) {
      return toast.error('Each shift needs a start and end as HH:MM')
    }
    const ids = new Set(cleaned.map((r) => r.id))
    if (ids.size !== cleaned.length) return toast.error('Each shift needs its own id')
    const offset = Number(zone)
    if (!Number.isInteger(offset) || offset < -12 * 60 || offset > 14 * 60) {
      return toast.error('Zone offset is minutes east of UTC, between -720 and 840')
    }
    setSaving(true)
    try {
      await saveSiteShifts({
        user: profile,
        siteId,
        shifts: cleaned,
        zoneOffsetMinutes: offset,
        current: settings,
      })
      toast.success(`Shift times saved for ${siteName}`)
    } catch (err) {
      toastCaught(err, 'Could not save shift times')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>} />}
        title="Shift times"
        subtitle="Permits use these clocks. Start and end are not typed on a request."
      />
      {!ready ? (
        <div className="py-16"><Spinner label="Loading shift times…" /></div>
      ) : (
        <form onSubmit={onSave} className="space-y-4">
          <Card animate={false} className="space-y-3 !p-5">
            <label className="block text-sm font-medium text-steel-100" htmlFor="shift-site">Site</label>
            <select
              id="shift-site"
              className="w-full rounded-lg border border-steel-600 bg-steel-900 px-3 py-2 text-sm text-steel-100"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            >
              {sites.length === 0 && <option value="">No sites yet</option>}
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name || s.id}</option>
              ))}
            </select>
            <Input
              label="Zone offset (minutes east of UTC)"
              type="number"
              value={zone}
              disabled={!isAdmin}
              onChange={(e) => setZone(e.target.value === '' ? '' : Number(e.target.value))}
            />
            <p className="text-xs text-steel-400">
              IST is 330. The permit rules read this when they check that a window is the shift, not a time someone typed.
              Until a site is saved, the defaults are Shift A 06:00–14:00, B 14:00–22:00, C 22:00–06:00 and General 09:00–18:00.
            </p>
          </Card>

          {rows.map((row, i) => (
            <Card key={i} animate={false} className="!p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Shift id" value={row.id} disabled={!isAdmin} onChange={(e) => setRow(i, { id: e.target.value })} />
                <Input label="Label" value={row.label} disabled={!isAdmin} onChange={(e) => setRow(i, { label: e.target.value })} />
                <Input label="Start (HH:MM)" value={row.start} disabled={!isAdmin} onChange={(e) => setRow(i, { start: e.target.value })} />
                <Input label="End (HH:MM)" value={row.end} disabled={!isAdmin} onChange={(e) => setRow(i, { end: e.target.value })} />
              </div>
              {isAdmin && (
                <button
                  type="button"
                  className="mt-3 text-xs font-medium text-danger hover:underline"
                  onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                >
                  Remove {row.label || row.id || 'shift'}
                </button>
              )}
            </Card>
          ))}

          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="steel" onClick={() => setRows((list) => [...list, blank()])}>
                Add shift
              </Button>
              <Button
                type="button"
                variant="steel"
                onClick={() => setRows(SHIFT_PRESETS.map((s) => ({ id: s.key, label: s.label, start: s.start, end: s.end })))}
              >
                Reset to defaults
              </Button>
              <Button type="submit" loading={saving} disabled={!siteId}>Save for {siteName || 'this site'}</Button>
            </div>
          )}
          {!isAdmin && (
            <p className="text-sm text-steel-300">Only an Admin can change shift times.</p>
          )}
        </form>
      )}
    </div>
  )
}
