import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import SiteScopePicker from '../../../../shared/org/SiteScopePicker'
import { subscribeSites as subscribeOrgSites } from '../../../../shared/org/orgData'
import { resolveAccessibleSites } from '../../../../shared/auth/access'
import { moduleLevelKeys, SITE_LEVEL_KEY } from '../../../../shared/org/scopeConfig'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import IsolationPointEditor from '../../components/procedures/IsolationPointEditor'
import { numberIsolationPoints, buildProcedureCode } from '../../utils/codes'
import { ENERGY_SOURCES } from '../../constants/energySources'
import {
  createProcedure,
  getProcedure,
  getProcedurePhotos,
  newProcedureId,
  reviseProcedure,
} from '../../services/procedures'
import { FullScreenLoader } from '../../components/ui/Spinner'

function blankPoint() {
  return {
    key: crypto.randomUUID(),
    energySource: ENERGY_SOURCES[0].key,
    devices: ['safety_padlock'],
    rating: '',
    isolationDetails: '',
    hazard: '',
    verification: '',
    photo: '',
    lockState: { locked: false, lockedBy: null, lockedByName: null, lockedAt: null },
  }
}

export default function CreateProcedure() {
  const { id: editId } = useParams()
  const isRevise = Boolean(editId)
  const { profile, org, isAdmin } = useAuth()
  const navigate = useNavigate()

  // Shared org sites (the same source the granularity config uses), narrowed to
  // what this user can access, so LOTO scope aligns with every other module.
  const [orgSites, setOrgSites] = useState([])
  useEffect(() => {
    return subscribeOrgSites(setOrgSites)
  }, [])
  const siteInventory = useMemo(
    () => resolveAccessibleSites(profile, orgSites, { isAdmin }),
    [profile, orgSites, isAdmin],
  )
  // A specific site is required only when the LOTO scope config still includes
  // the Site level; if an admin removes it, procedures become region/entity-scoped.
  const scopeHasSite = useMemo(() => moduleLevelKeys(org, 'loto').includes(SITE_LEVEL_KEY), [org])

  // Stable procedure id (new or existing) so photo uploads land correctly.
  const procedureIdRef = useRef(editId || newProcedureId())
  const procedureId = procedureIdRef.current

  const [loading, setLoading] = useState(isRevise)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ site: '', region: '', entity: '', siteId: '', equipment: '', equipmentDetails: '' })
  const [points, setPoints] = useState([blankPoint()])

  useEffect(() => {
    if (!isRevise) return
    let active = true
    Promise.all([getProcedure(editId), getProcedurePhotos(editId)])
      .then(([p, photos]) => {
        if (!active) return
        if (!p) {
          toast.error('Procedure not found')
          navigate('/loto/inventory')
          return
        }
        setForm({
          site: p.site || '',
          region: p.region || '',
          entity: p.entity || '',
          siteId: p.siteId || '',
          equipment: p.equipment || '',
          equipmentDetails: p.equipmentDetails || '',
        })
        setPoints(
          (p.isolationPoints || []).map((pt) => {
            const key = pt.key || crypto.randomUUID()
            return { ...blankPoint(), ...pt, key, photo: photos[key] || '' }
          }),
        )
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [editId, isRevise, navigate])

  const numbered = useMemo(() => numberIsolationPoints(points), [points])

  const updatePoint = (idx, next) =>
    setPoints((ps) => ps.map((p, i) => (i === idx ? next : p)))
  const removePoint = (idx) =>
    setPoints((ps) => ps.filter((_, i) => i !== idx))
  const addPoint = () => setPoints((ps) => [...ps, blankPoint()])

  const procedureCode = buildProcedureCode({
    orgName: org?.name,
    site: form.site,
    equipment: form.equipment,
  })

  async function handleSave() {
    // Equipment name is optional — the equipment/machine can instead be captured
    // through the configured site-scope levels (e.g. a "Machine" granularity level).
    if (scopeHasSite && !form.site.trim()) return toast.error('Site is required')
    if (points.length === 0) return toast.error('Add at least one isolation point')
    for (const p of points) {
      if (!p.isolationDetails.trim()) {
        return toast.error('Each isolation point needs isolation details')
      }
    }

    setSaving(true)
    // Photos travel in a separate doc; the main doc keeps only a hasPhoto flag.
    const photosMap = {}
    numbered.forEach((p) => {
      if (p.photo) photosMap[p.key] = p.photo
    })
    const payload = {
      orgName: org?.name || '',
      site: form.site.trim(),
      region: form.region || '',
      entity: form.entity || '',
      siteId: form.siteId || '',
      equipment: form.equipment.trim(),
      equipmentDetails: form.equipmentDetails.trim(),
      procedureCode,
      isolationPoints: numbered,
    }
    try {
      if (isRevise) {
        await reviseProcedure(procedureId, payload, profile, photosMap)
        toast.success('Revision saved')
      } else {
        await createProcedure(procedureId, payload, profile, photosMap)
        toast.success('Procedure created')
      }
      navigate(`/loto/procedures/${procedureId}`)
    } catch (err) {
      toastCaught(err, 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <FullScreenLoader label="Loading procedure…" />

  // Energy-source tally for the live summary chips.
  const tally = numbered.reduce((acc, p) => {
    acc[p.energyLabel] = (acc[p.energyLabel] || 0) + 1
    return acc
  }, {})

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-steel-50">
            {isRevise ? 'Revise procedure' : 'Create LOTO procedure'}
          </h1>
          <p className="mt-1 text-sm text-steel-400">
            {isRevise
              ? 'Saving creates a new revision and resets approval status.'
              : 'Define the equipment and each energy isolation point.'}
          </p>
        </div>
        <div className="rounded-lg border border-steel-700 bg-steel-900/60 px-3 py-1.5 text-right">
          <div className="text-[10px] uppercase tracking-widest text-steel-400">
            Procedure code
          </div>
          <div className="font-mono text-sm font-bold text-amber-600">{procedureCode}</div>
        </div>
      </div>

      {/* Equipment block */}
      <div className="mt-6 grid gap-4 rounded-2xl border border-steel-700 bg-steel-900/50 p-5 md:grid-cols-2">
        <Input
          label="Organization"
          value={org?.name || ''}
          disabled
          className="opacity-70"
        />
        <div className="block">
          <span className="mb-1.5 block text-sm font-medium text-steel-200">Site scope</span>
          {siteInventory.length === 0 ? (
            <div className="ring-1 ring-ink-200 rounded-xl bg-surface-50 px-3.5 py-2.5 text-sm text-steel-400 ">
              No sites you can access yet.{' '}
              {isAdmin ? (
                <Link to="/sites" className="font-semibold text-amber-600">
                  Add sites
                </Link>
              ) : (
                'Ask an admin to add sites and grant you access.'
              )}
            </div>
          ) : (
            <SiteScopePicker
              module="loto"
              sites={siteInventory}
              value={form}
              onChange={(v) => setForm((f) => ({ ...f, ...v }))}
            />
          )}
        </div>
        <Input
          label="Equipment (optional)"
          value={form.equipment}
          onChange={(e) => setForm((f) => ({ ...f, equipment: e.target.value }))}
          placeholder="e.g. Conveyor CV-104"
        />
        <Input
          label="Equipment details (optional)"
          value={form.equipmentDetails}
          onChange={(e) =>
            setForm((f) => ({ ...f, equipmentDetails: e.target.value }))
          }
          placeholder="Asset tag, location notes…"
        />
      </div>

      {/* Isolation points */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-steel-400">
          Isolation points ({points.length})
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(tally).map(([label, n]) => (
            <span
              key={label}
              className="rounded-full border border-steel-700 bg-steel-900/60 px-2 py-0.5 text-[11px] text-steel-300"
            >
              {label.replace(' Energy', '')}: {n}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <AnimatePresence initial={false}>
          {numbered.map((p, idx) => (
            <IsolationPointEditor
              key={p.key}
              point={p}
              index={idx}
              pointId={p.pointId}
             
              procedureId={procedureId}
              onChange={(next) => updatePoint(idx, next)}
              onRemove={() => removePoint(idx)}
            />
          ))}
        </AnimatePresence>
      </div>

      <motion.button
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
        onClick={addPoint}
        className="mt-4 w-full rounded-2xl border border-dashed border-steel-600 py-3 text-sm font-semibold text-steel-300 hover:border-hazard hover:text-amber-600"
      >
        + Add isolation point
      </motion.button>

      <div className="sticky bottom-0 mt-8 flex justify-end gap-2 border-t border-steel-800 bg-steel-950/80 py-4 backdrop-blur">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button loading={saving} onClick={handleSave}>
          {isRevise ? 'Save revision' : 'Create procedure'}
        </Button>
      </div>
    </div>
  )
}
