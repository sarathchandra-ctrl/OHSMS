import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import {
  Settings,
  Save,
  Activity,
  Plus,
  X,
  Layers,
  ChevronUp,
  ChevronDown,
  Lock,
  Building2,
  PhoneCall,
  LifeBuoy,
  ImageUp,
  Trash2,
  Plug,
  Palette,
} from 'lucide-react'
import { ERP_ROLES, normalizeErpRoleLabels } from '../../shared/org/erpRoles'
import { DEPARTMENTS } from '../../shared/auth/access'
import { useAuth } from '../../shared/auth/AuthContext'
import {
  subscribeOrg,
  updateOrgSettings,
  subscribeSites,
  backfillEmptySiteTypes,
} from '../../shared/org/orgData'
import {
  normalizeOverrides,
  packOverrides,
  packSiteTypeByEntity,
  rowsFromSiteTypeByEntity,
  activityPickerOptions,
} from '../../shared/weather/activityPrecautions'
import WeatherPrecautions from './WeatherPrecautions'
import SiteTypeBackfill from './SiteTypeBackfill'
import { MODULES } from '../../shared/modules/registry'
import {
  BUILTIN_FIELDS,
  SITE_LEVEL,
  SITE_LEVEL_KEY,
  DEFAULT_LEVEL_KEYS,
  normalizeScopeConfig,
  moduleLevelKeys,
  distinctSiteValues,
  toFieldKey,
} from '../../shared/org/scopeConfig'
import {
  putFile,
  removeFile,
  MAX_INLINE_BYTES,
  tooLargeForInline,
  formatSize,
} from '../../shared/storage'
import { fileToDataUrl } from '../../shared/lib/files'
import { safeSrc } from '../../shared/safeUrl'
import { useFileUrl } from '../../shared/storage/useFileUrl'
import { hasOrgLogo } from '../../shared/branding/OrgMark'
import { fileToLogoThumb } from '../../shared/branding/logoThumb'
import {
  CANVAS_SWATCHES,
  DEFAULT_ACCENT,
  DEFAULT_CANVAS,
  extractPaletteFromFile,
  extractPaletteFromSrc,
  lightCanvas,
  mixHex,
  nextTheme,
  normalizeTheme,
  paletteFromLogo,
  themePatchForLogo,
} from '../../shared/branding/theme'
import {
  PageHeader,
  Card,
  Field,
  Input,
  Select,
  Button,
  MultiSelect,
  SkeletonCard,
} from '../../shared/ui'
import MetabaseSettings from './MetabaseSettings'
import WhatsAppConnect from './WhatsAppConnect.jsx'

const TABS = [
  { key: 'general', label: 'General', icon: Settings },
  { key: 'scope', label: 'Scope & Granularity', icon: Layers },
  { key: 'integrations', label: 'Integrations', icon: Plug },
]

// A logo rides on every page load for every member, so it gets a far tighter
// ceiling than the 10MB an evidence photo may be. 2MB is generous for a mark.
const MAX_LOGO_BYTES = 2 * 1024 * 1024

export default function OrgSettings() {
  const { actor } = useAuth()
  const [org, setOrg] = useState(null)
  const [tab, setTab] = useState('general')
  const [sites, setSites] = useState([])

  // The preview below used to read `org.logoUrl` straight into an <img>. That
  // field is a permanent download URL and uploads no longer mint one (audit
  // finding M-5), so a logo set after that change carries only `logoPath` —
  // and the old check would have reported "No logo yet" for a logo that had
  // just been uploaded successfully.
  const { src: logoSrc, loading: logoLoading } = useFileUrl({
    url: org?.logoUrl,
    path: org?.logoPath,
  })
  const hasLogo = hasOrgLogo(org)

  const [form, setForm] = useState({
    name: '',
    address: '',
    notificationEmail: '',
    activityTypes: [],
    weatherPrecautions: {},
    siteTypeByEntityRows: [],
    departments: [],
    safetyHelplinePrimary: '',
    safetyHelplineSecondary: '',
    erpRoleLabels: {},
  })
  const [customActivity, setCustomActivity] = useState('')
  const [newDept, setNewDept] = useState('')
  const [busy, setBusy] = useState(false)

  // The logo is NOT part of `form`, deliberately. subscribeOrg below rewrites
  // `form` on every snapshot, so a picked-but-unsaved logo would vanish the
  // moment anyone touched the org document — and "I uploaded it and it went
  // away" is the worst possible failure for a one-click action. It is written
  // the instant it is chosen, and read back off the live `org`.
  const [logoBusy, setLogoBusy] = useState(false)
  const logoRef = useRef(null)
  const [themeBusy, setThemeBusy] = useState(false)

  // Scope granularity state
  const [customFields, setCustomFields] = useState([]) // [{ key, label, options }]
  const [moduleLevels, setModuleLevels] = useState({}) // { [moduleKey]: [levelKey…] }
  const [newField, setNewField] = useState('')
  const [optionDraft, setOptionDraft] = useState({}) // { [fieldKey]: text }
  const [scopeModule, setScopeModule] = useState(MODULES[0].key)
  const [scopeBusy, setScopeBusy] = useState(false)

  useEffect(() => {
    return subscribeOrg((o) => {
      setOrg(o)
      if (o) {
        setForm({
          name: o.name || '',
          address: o.address || '',
          notificationEmail: o.notificationEmail || '',
          safetyHelplinePrimary: o.safetyHelplinePrimary || '',
          safetyHelplineSecondary: o.safetyHelplineSecondary || '',
          activityTypes: o.activityTypes || [],
          weatherPrecautions: normalizeOverrides(o.weatherPrecautions),
          siteTypeByEntityRows: rowsFromSiteTypeByEntity(o.siteTypeByEntity, o.activityTypes),
          departments:
            Array.isArray(o.departments) && o.departments.length ? o.departments : DEPARTMENTS,
          erpRoleLabels: normalizeErpRoleLabels(o.erpRoleLabels),
        })
        const cfg = normalizeScopeConfig(o.scopeConfig)
        setCustomFields(cfg.customFields)
        setModuleLevels(cfg.modules)
      }
    })
  }, [])

  useEffect(() => {
    return subscribeSites(setSites)
  }, [])

  // Path-only logos (uploads that landed after M-5 with an empty logoUrl) leave
  // the header depending on Storage. When an admin opens this page and the path
  // resolves, write the small thumb back so every member has a chrome fallback
  // without re-uploading.
  useEffect(() => {
    if (!actor || !org?.logoPath || org?.logoUrl || !logoSrc || logoLoading) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(logoSrc)
        const blob = await res.blob()
        if (!blob.type.startsWith('image/')) return
        const thumb = await fileToLogoThumb(blob)
        if (cancelled || !thumb) return
        await updateOrgSettings({ logoUrl: thumb }, actor)
      } catch {
        // Best-effort. A failed backfill leaves the path in place; re-upload
        // still writes a thumb.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [actor, org?.logoPath, org?.logoUrl, logoSrc, logoLoading])

  const activityOptions = useMemo(
    () => activityPickerOptions(form.activityTypes),
    [form.activityTypes]
  )

  const addCustomActivity = () => {
    const v = customActivity.trim()
    if (!v) return
    if (!form.activityTypes.includes(v))
      setForm({ ...form, activityTypes: [...form.activityTypes, v] })
    setCustomActivity('')
  }

  const addDept = () => {
    const v = newDept.trim()
    if (!v) return
    if (form.departments.some((d) => d.toLowerCase() === v.toLowerCase()))
      return toast.error('That department already exists')
    setForm({ ...form, departments: [...form.departments, v] })
    setNewDept('')
  }
  const removeDept = (d) =>
    setForm({ ...form, departments: form.departments.filter((x) => x !== d) })

  // ── Organization logo ───────────────────────────────────────────────────────
  //
  // Cloud storage first, inline data URL as the fallback — the same bargain
  // every other upload in this app makes, and it matters more here: the org
  // document is read by every member on every page load, so an inline logo is
  // bytes on all of those reads. The fallback exists so a deployment whose
  // bucket is not enabled yet can still be branded, under the tighter cap a
  // Firestore document imposes.
  const saveLogo = async (patch) => {
    const previousPath = org?.logoPath || ''
    await updateOrgSettings(patch, actor)
    // Only after the document points somewhere else. Deleting first would leave
    // the header pointing at bytes that are already gone if the write failed.
    if (previousPath && previousPath !== patch.logoPath) removeFile(previousPath)
  }

  const onLogo = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    // Not SVG, and the message no longer offers it. storage.rules refuses that
    // type for every upload in the product: an SVG is a document that can carry
    // script, and a bucket object is served under the type it was stored with
    // from a permanent unauthenticated link. Refused here as well as there so
    // the person is told, rather than falling through to the inline path and
    // wondering why a large logo suddenly will not save.
    if (!file.type.startsWith('image/') || file.type.includes('svg')) {
      return toast.error('Pick an image file — PNG or JPEG works best')
    }
    if (file.size > MAX_LOGO_BYTES) {
      return toast.error(`Logo too large — keep it under ${formatSize(MAX_LOGO_BYTES)}`)
    }
    setLogoBusy(true)
    try {
      // Sample the file and the thumb together. A decoder that refuses the
      // original must not persist the kit hexes as if they had been read off
      // the mark — that write is what stopped every later page from trying
      // again. The thumb is a same-origin JPEG, so it still yields a palette
      // when createObjectURL on the original does not. No palette at all means
      // the theme field is left untouched and OrgTheme samples on load.
      const [filePalette, thumb] = await Promise.all([
        extractPaletteFromFile(file).catch(() => null),
        fileToLogoThumb(file).catch(() => ''),
      ])
      let palette = filePalette
      if (!paletteFromLogo(palette) && thumb) {
        try {
          palette = await extractPaletteFromSrc(thumb)
        } catch {
          palette = null
        }
      }
      const theme = themePatchForLogo(org?.theme, palette)
      const up = await putFile('org-logo', file, file.name)
      // Always keep a small inline thumb in `logoUrl`. putFile returns an empty
      // url after M-5 (no permanent download token). The header paints that
      // thumb even when the Storage fetch later returns a download URL it
      // cannot display. Theme is attached only when the bitmap actually
      // produced colours — persisting the kit pair used to lock the amber
      // page in place.
      const withTheme = (patch) => (theme ? { ...patch, theme } : patch)
      if (up) {
        await saveLogo(withTheme({ logoUrl: thumb || up.url || '', logoPath: up.path }))
      } else {
        if (file.size > MAX_INLINE_BYTES) return toast.error(tooLargeForInline(file.name))
        const dataUrl = thumb || (await fileToDataUrl(file))
        await saveLogo(withTheme({ logoUrl: dataUrl, logoPath: '' }))
      }
      toast.success('Logo updated')
    } catch (err) {
      toastCaught(err, 'Could not save the logo')
    } finally {
      setLogoBusy(false)
    }
  }

  const clearLogo = async () => {
    setLogoBusy(true)
    try {
      const prev = normalizeTheme(org?.theme)
      await saveLogo({
        logoUrl: '',
        logoPath: '',
        theme: nextTheme(prev, {
          accent: DEFAULT_ACCENT,
          canvas: prev.canvasSource === 'custom' ? prev.canvas : DEFAULT_CANVAS,
          canvasSource: prev.canvasSource === 'custom' ? 'custom' : 'default',
        }),
      })
      toast.success('Logo removed — the WE EHS mark is back in the header')
    } catch (err) {
      toastCaught(err, 'Could not remove the logo')
    } finally {
      setLogoBusy(false)
    }
  }

  const persistTheme = async (patch, ok = 'Appearance updated') => {
    setThemeBusy(true)
    try {
      const theme = nextTheme(org?.theme, patch)
      await updateOrgSettings({ theme }, actor)
      toast.success(ok)
    } catch (err) {
      toastCaught(err, 'Could not save appearance')
    } finally {
      setThemeBusy(false)
    }
  }

  const onPickCanvas = (hex, source) => persistTheme({ canvas: hex, canvasSource: source })

  const onResampleLogo = async () => {
    if (!logoSrc) return toast.error('Upload a logo first')
    setThemeBusy(true)
    try {
      const palette = await extractPaletteFromSrc(logoSrc)
      const prev = normalizeTheme(org?.theme)
      await updateOrgSettings(
        {
          theme: nextTheme(prev, {
            accent: palette.accent,
            canvas: prev.canvasSource === 'custom' ? prev.canvas : palette.canvasWash,
            canvasSource: prev.canvasSource === 'custom' ? 'custom' : 'logo',
          }),
        },
        actor
      )
      toast.success('Colours taken from the logo')
    } catch (err) {
      toastCaught(err, 'Could not read colours from the logo')
    } finally {
      setThemeBusy(false)
    }
  }

  const saveGeneral = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await updateOrgSettings(
        {
          name: form.name,
          address: form.address,
          notificationEmail: form.notificationEmail,
          safetyHelplinePrimary: form.safetyHelplinePrimary,
          safetyHelplineSecondary: form.safetyHelplineSecondary,
          activityTypes: form.activityTypes,
          weatherPrecautions: packOverrides(form.weatherPrecautions),
          siteTypeByEntity: packSiteTypeByEntity(form.siteTypeByEntityRows, form.activityTypes).map,
          departments: form.departments,
          erpRoleLabels: form.erpRoleLabels,
        },
        actor
      )
      toast.success('Settings saved')
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setBusy(false)
    }
  }

  // Apply writes the plan the admin just previewed. The button rebuilds that
  // plan from the live site list first; if a site gained a type in between,
  // the counts change and the write waits for another preview.
  const applySiteTypes = async (plan) => {
    setBusy(true)
    try {
      const packed = packSiteTypeByEntity(form.siteTypeByEntityRows, form.activityTypes)
      await updateOrgSettings({ siteTypeByEntity: packed.map }, actor)
      const n = await backfillEmptySiteTypes(plan.updates, actor)
      toast.success(
        n ? `Filled the site type on ${n} site${n === 1 ? '' : 's'}` : 'No sites needed a type'
      )
    } catch (err) {
      toastCaught(err, 'Could not fill site types')
    } finally {
      setBusy(false)
    }
  }

  // ── Scope granularity helpers ──────────────────────────────────────────────
  const allFields = useMemo(() => [...BUILTIN_FIELDS, SITE_LEVEL, ...customFields], [customFields])
  const fieldLabel = (key) => allFields.find((f) => f.key === key)?.label || key

  // Ordered levels for the module being edited (Site is a normal, removable level).
  const levelsForModule = useMemo(
    () => moduleLevelKeys({ scopeConfig: { customFields, modules: moduleLevels } }, scopeModule),
    [customFields, moduleLevels, scopeModule]
  )
  const setLevelsFor = (keys) => setModuleLevels((m) => ({ ...m, [scopeModule]: keys }))

  const addLevel = (key) => {
    if (key && !levelsForModule.includes(key)) setLevelsFor([...levelsForModule, key])
  }
  const removeLevel = (key) => setLevelsFor(levelsForModule.filter((k) => k !== key))
  const moveLevel = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= levelsForModule.length) return
    const next = levelsForModule.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setLevelsFor(next)
  }

  const addCustomField = () => {
    const label = newField.trim()
    const key = toFieldKey(label)
    if (!label || !key) return
    if (allFields.some((f) => f.key === key)) {
      toast.error('That field already exists')
      return
    }
    setCustomFields((f) => [...f, { key, label, options: [] }])
    setNewField('')
  }
  const addOption = (fieldKey) => {
    const val = (optionDraft[fieldKey] || '').trim()
    if (!val) return
    setCustomFields((fields) =>
      fields.map((f) =>
        f.key === fieldKey
          ? { ...f, options: f.options.includes(val) ? f.options : [...f.options, val] }
          : f
      )
    )
    setOptionDraft((d) => ({ ...d, [fieldKey]: '' }))
  }
  const removeOption = (fieldKey, val) =>
    setCustomFields((fields) =>
      fields.map((f) =>
        f.key === fieldKey ? { ...f, options: f.options.filter((o) => o !== val) } : f
      )
    )
  const removeCustomField = (key) => {
    setCustomFields((f) => f.filter((x) => x.key !== key))
    // Drop it from every module's level list too.
    setModuleLevels((m) => {
      const out = {}
      for (const [mk, keys] of Object.entries(m)) out[mk] = keys.filter((k) => k !== key)
      return out
    })
  }

  const unusedFields = allFields.filter((f) => !levelsForModule.includes(f.key))

  const saveScope = async () => {
    setScopeBusy(true)
    try {
      // Persist only modules that differ from the default, keeping the doc lean.
      const modules = {}
      for (const m of MODULES) {
        const keys = moduleLevelKeys(
          { scopeConfig: { customFields, modules: moduleLevels } },
          m.key
        )
        if (JSON.stringify(keys) !== JSON.stringify(DEFAULT_LEVEL_KEYS)) modules[m.key] = keys
      }
      await updateOrgSettings({ scopeConfig: { customFields, modules } }, actor)
      toast.success('Scope settings saved')
    } catch (err) {
      toastCaught(err, 'Failed')
    } finally {
      setScopeBusy(false)
    }
  }

  const previewFor = (key) => {
    if (key === SITE_LEVEL_KEY)
      return `The specific site record — ${sites.length} site${sites.length === 1 ? '' : 's'} available`
    const vals = distinctSiteValues(sites, key)
    if (!vals.length) return 'No values in site data yet'
    return `${vals.slice(0, 4).join(', ')}${vals.length > 4 ? `, +${vals.length - 4} more` : ''} (${vals.length})`
  }

  const theme = normalizeTheme(org?.theme)
  const logoWash = lightCanvas(mixHex(theme.accent, '#ffffff', 0.82))
  const canvasSwatches = [
    ...CANVAS_SWATCHES,
    ...(hasLogo ? [{ id: 'logo', hex: logoWash, label: 'From logo' }] : []),
  ]

  if (org === null) {
    return (
      <>
        <PageHeader
          title="Organization settings"
          subtitle="Manage your organization profile"
          icon={Settings}
        />
        <SkeletonCard className="max-w-2xl" />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Organization settings"
        subtitle="Profile, branding, scope granularity & integrations"
        icon={Settings}
      />

      {/* Tab bar */}
      <div className="tab-strip mb-5" role="tablist" aria-label="Organization settings">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            role="tab"
            aria-selected={tab === t.key}
            className={`nav-tab ${tab === t.key ? 'nav-tab-active' : 'nav-tab-idle'}`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <form onSubmit={saveGeneral} className="max-w-2xl space-y-5">
          <Card>
            <h3 className="mb-4 font-semibold text-ink-800">Profile</h3>
            <div className="space-y-4">
              <Field label="Organization name" htmlFor="name">
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Address" htmlFor="address">
                <Input
                  id="address"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </Field>
              <Field
                label="Notification email"
                htmlFor="email"
                hint="Where safety notifications are sent"
              >
                <Input
                  id="email"
                  type="email"
                  value={form.notificationEmail}
                  onChange={(e) => setForm({ ...form, notificationEmail: e.target.value })}
                />
              </Field>
            </div>
          </Card>

          {/* Brand mark. Saved on pick rather than on Submit — see the comment
              on logoBusy above. */}
          <Card>
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <ImageUp size={17} className="text-brand-600" /> Organization logo
            </h3>
            <p className="mb-4 mt-1 text-sm text-ink-500">
              Shown in the top-left corner of every screen, in place of the WE EHS mark when none is
              set. PNG or JPEG with a transparent background looks best; up to{' '}
              {formatSize(MAX_LOGO_BYTES)}.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <div className="grid h-20 w-20 flex-none place-items-center rounded-2xl bg-ink-50 ring-1 ring-white/70">
                {safeSrc(logoSrc) ? (
                  <img
                    src={safeSrc(logoSrc)}
                    alt={`${form.name || 'Organization'} logo`}
                    className="h-16 w-16 rounded-xl bg-ink-50 object-contain p-0.5"
                  />
                ) : hasLogo && logoLoading ? (
                  <span className="skeleton h-16 w-16 rounded-xl" />
                ) : (
                  <span className="px-2 text-center text-[10.5px] font-semibold leading-tight text-ink-400">
                    No logo yet
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* type="button" on both: this card sits inside the General
                    form, and a bare <button> there submits it. */}
                <Button
                  type="button"
                  variant="soft"
                  icon={logoBusy ? undefined : ImageUp}
                  loading={logoBusy}
                  onClick={() => logoRef.current?.click()}
                >
                  {hasLogo ? 'Replace logo' : 'Upload logo'}
                </Button>
                {hasLogo && (
                  <Button
                    type="button"
                    variant="ghost"
                    icon={Trash2}
                    disabled={logoBusy}
                    onClick={clearLogo}
                  >
                    Remove
                  </Button>
                )}
                <input
                  ref={logoRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onLogo}
                />
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <Palette size={17} className="text-brand-600" /> Appearance
            </h3>
            <p className="mb-4 mt-1 text-sm text-ink-500">
              Accents follow the uploaded logo. The page background is yours to pick — a dark colour
              is lightened automatically so text stays readable.
            </p>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className="grid h-10 w-10 place-items-center rounded-2xl ring-1 ring-white/70"
                  style={{ backgroundColor: theme.accent }}
                  title="Accent from logo"
                />
                <span
                  className="grid h-10 w-14 rounded-2xl ring-1 ring-ink-200"
                  style={{ backgroundColor: theme.canvas }}
                  title="Page background"
                />
                <p className="text-sm text-ink-500">
                  {theme.canvasSource === 'logo'
                    ? 'Background taken from the logo.'
                    : theme.canvasSource === 'custom'
                      ? 'Custom background.'
                      : 'Default amber wash.'}
                </p>
              </div>
              <div>
                <p className="label" id="canvas-swatches-label">
                  Page background
                </p>
                <div
                  role="radiogroup"
                  aria-labelledby="canvas-swatches-label"
                  className="flex flex-wrap items-center gap-2"
                >
                  {canvasSwatches.map((s) => {
                    const selected =
                      theme.canvas.toLowerCase() === s.hex.toLowerCase() ||
                      (s.id === 'logo' && theme.canvasSource === 'logo')
                    return (
                      <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={s.label}
                        disabled={themeBusy}
                        onClick={() =>
                          onPickCanvas(
                            s.hex,
                            s.id === 'logo' ? 'logo' : s.id === 'amber' ? 'default' : 'custom'
                          )
                        }
                        className={`h-9 w-9 rounded-full ring-1 transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
                          selected ? 'ring-2 ring-brand-600' : 'ring-ink-200 hover:ring-ink-400'
                        }`}
                        style={{ backgroundColor: s.hex }}
                        title={s.label}
                      />
                    )
                  })}
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Custom colour" htmlFor="canvas-color">
                  <input
                    id="canvas-color"
                    type="color"
                    value={theme.canvas}
                    disabled={themeBusy}
                    onChange={(e) => onPickCanvas(e.target.value, 'custom')}
                    className="h-10 w-16 cursor-pointer rounded-xl border-0 bg-transparent p-0"
                  />
                </Field>
                {hasLogo && (
                  <Button
                    type="button"
                    variant="soft"
                    icon={Palette}
                    disabled={themeBusy || !logoSrc}
                    onClick={onResampleLogo}
                  >
                    Use colours from logo
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {/* Org-wide emergency helpline — same on every site's SOS poster */}
          <Card>
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <PhoneCall size={17} className="text-red-600" /> Safety &amp; Security helpline
            </h3>
            <p className="mb-3 mt-1 text-sm text-ink-500">
              Your organization-wide helpline numbers. These are common to every site and print on
              the
              <b> Safety &amp; Security (Help Line)</b> row of each site&apos;s SOS emergency
              poster.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Primary helpline" htmlFor="hl1" hint="e.g. 1800 102 4100">
                <Input
                  id="hl1"
                  value={form.safetyHelplinePrimary}
                  onChange={(e) => setForm({ ...form, safetyHelplinePrimary: e.target.value })}
                />
              </Field>
              <Field label="Secondary helpline" htmlFor="hl2" hint="e.g. 9591900100">
                <Input
                  id="hl2"
                  value={form.safetyHelplineSecondary}
                  onChange={(e) => setForm({ ...form, safetyHelplineSecondary: e.target.value })}
                />
              </Field>
            </div>
          </Card>

          {/* Emergency response role names. The baseline rescue plans are written
              against roles, not people; this is where an organization says what
              it calls each one. */}
          <Card>
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <LifeBuoy size={17} className="text-red-600" /> Emergency response roles
            </h3>
            <p className="mb-3 mt-1 text-sm text-ink-500">
              The baseline rescue plans name a <b>role</b> for every step, never a person. Set what
              your organization calls each role and it will read in your own language across rescue
              plans, emergency contacts, mock drills and printed plans. Renaming is safe at any time
              — existing records are unaffected.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {ERP_ROLES.filter((r) => r.key !== 'Other').map((r) => (
                <Field
                  key={r.key}
                  label={r.duty}
                  htmlFor={`role-${r.key}`}
                  hint={`Default: ${r.label}`}
                >
                  <Input
                    id={`role-${r.key}`}
                    value={form.erpRoleLabels?.[r.key] ?? ''}
                    placeholder={r.label}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        erpRoleLabels: { ...form.erpRoleLabels, [r.key]: e.target.value },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </Card>

          <Card>
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <Activity size={17} className="text-brand-600" /> Activities performed
            </h3>
            <p className="mb-3 mt-1 text-sm text-ink-500">
              Select the types of activity your organization performs. Add your own if it&apos;s not
              listed. Anything you add here is also a site type, and you can write its heat, rain
              and adverse-weather precautions below.
            </p>
            <MultiSelect
              options={activityOptions}
              value={form.activityTypes}
              onChange={(activityTypes) => setForm({ ...form, activityTypes })}
              maxHeight="max-h-56"
            />
            <div className="mt-2 flex gap-2">
              <Input
                placeholder="Add a custom activity…"
                value={customActivity}
                onChange={(e) => setCustomActivity(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustomActivity()
                  }
                }}
              />
              <Button type="button" variant="soft" icon={Plus} onClick={addCustomActivity}>
                Add
              </Button>
            </div>
          </Card>

          <WeatherPrecautions
            activityTypes={form.activityTypes}
            value={form.weatherPrecautions}
            onChange={(weatherPrecautions) => setForm({ ...form, weatherPrecautions })}
          />

          <SiteTypeBackfill
            rows={form.siteTypeByEntityRows}
            onChange={(siteTypeByEntityRows) => setForm({ ...form, siteTypeByEntityRows })}
            activityTypes={form.activityTypes}
            sites={sites}
            busy={busy}
            onApply={applySiteTypes}
          />

          {/* Departments — populate every department dropdown across all modules */}
          <Card>
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <Building2 size={17} className="text-brand-600" /> Departments
            </h3>
            <p className="mb-3 mt-1 text-sm text-ink-500">
              Your organization&apos;s departments. These populate the department dropdowns across
              all modules — employee provisioning, access requests, training group assignments and
              reports.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="e.g. Quality Assurance"
                value={newDept}
                onChange={(e) => setNewDept(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addDept()
                  }
                }}
              />
              <Button type="button" variant="soft" icon={Plus} onClick={addDept}>
                Add
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {form.departments.map((d) => (
                <span key={d} className="chip bg-surface-100 text-ink-700">
                  {d}
                  <button
                    type="button"
                    onClick={() => removeDept(d)}
                    className="text-ink-400 hover:text-red-600"
                    title="Remove department"
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
              {form.departments.length === 0 && (
                <span className="text-sm text-ink-400">
                  No departments — the defaults ({DEPARTMENTS.join(', ')}) will be used.
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-ink-400">
              Removing a department here doesn&apos;t change employees already mapped to it — their
              records keep the old name.
            </p>
          </Card>

          <div className="flex justify-end">
            <Button type="submit" icon={Save} loading={busy}>
              Save changes
            </Button>
          </div>
        </form>
      )}

      {tab === 'scope' && (
        <div className="max-w-3xl space-y-5">
          <Card>
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <Layers size={17} className="text-brand-600" /> Custom scope fields
            </h3>
            <p className="mb-3 mt-1 text-sm text-ink-500">
              Define extra location attributes (e.g. <b>Building</b>, <b>Floor</b>, <b>Zone</b>)
              beyond Region and Entity. These become fields on every Site and can be added as
              granularity levels below. Give each one its predefined dropdown values here — any
              extra values found in your site data are added automatically.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="e.g. Building"
                value={newField}
                onChange={(e) => setNewField(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustomField()
                  }
                }}
              />
              <Button type="button" variant="soft" icon={Plus} onClick={addCustomField}>
                Add field
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {BUILTIN_FIELDS.map((f) => (
                <span
                  key={f.key}
                  className="chip bg-ink-100 text-ink-500"
                  title="Built-in field — values come from site data"
                >
                  <Lock size={12} /> {f.label}
                </span>
              ))}
            </div>

            <div className="mt-3 space-y-3">
              {customFields.length === 0 && (
                <p className="text-sm text-ink-400">No custom fields yet.</p>
              )}
              {customFields.map((f) => (
                <div key={f.key} className="ring-1 ring-ink-200 rounded-2xl bg-surface-50/60 p-3 ">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-ink-800">{f.label}</p>
                    <button
                      type="button"
                      onClick={() => removeCustomField(f.key)}
                      className="rounded-lg p-1 text-ink-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-400">Predefined dropdown values</p>
                  {f.options.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {f.options.map((o) => (
                        <span key={o} className="chip bg-surface-100 text-ink-700">
                          {o}
                          <button
                            type="button"
                            onClick={() => removeOption(f.key, o)}
                            className="text-ink-400 hover:text-red-600"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Input
                      placeholder={`Add a ${f.label.toLowerCase()} value…`}
                      value={optionDraft[f.key] || ''}
                      onChange={(e) => setOptionDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addOption(f.key)
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="soft"
                      icon={Plus}
                      onClick={() => addOption(f.key)}
                    >
                      Add value
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 font-semibold text-ink-800">
                <Layers size={17} className="text-brand-600" /> Scope levels per module
              </h3>
              <Select
                className="!w-auto !py-2"
                value={scopeModule}
                onChange={(e) => setScopeModule(e.target.value)}
              >
                {MODULES.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </div>
            <p className="mb-4 mt-1 text-sm text-ink-500">
              Choose which fields — and in what order — a user fills to define scope in{' '}
              <b>{MODULES.find((m) => m.key === scopeModule)?.label}</b>. Any level, including Site,
              can be added, reordered or removed.
            </p>

            <ol className="space-y-2">
              {levelsForModule.map((key, i) => (
                <li
                  key={key}
                  className="ring-1 ring-ink-200 flex items-center gap-2 rounded-2xl bg-surface-50/60 px-3 py-2 "
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-500 text-xs font-bold text-white">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-800">{fieldLabel(key)}</p>
                    <p className="truncate text-xs text-ink-400">{previewFor(key)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => moveLevel(i, -1)}
                    disabled={i === 0}
                    className="rounded-lg p-1 text-ink-400 hover:bg-surface-100 hover:text-ink-700 disabled:opacity-30"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveLevel(i, 1)}
                    disabled={i === levelsForModule.length - 1}
                    className="rounded-lg p-1 text-ink-400 hover:bg-surface-100 hover:text-ink-700 disabled:opacity-30"
                  >
                    <ChevronDown size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeLevel(key)}
                    disabled={levelsForModule.length === 1}
                    title={
                      levelsForModule.length === 1
                        ? 'At least one level is required'
                        : 'Remove level'
                    }
                    className="rounded-lg p-1 text-ink-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                  >
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ol>

            {unusedFields.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
                <span className="text-xs font-bold uppercase tracking-wide text-ink-400">
                  Add level
                </span>
                {unusedFields.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => addLevel(f.key)}
                    className="chip bg-brand-50 text-brand-700 hover:bg-brand-100"
                  >
                    <Plus size={13} /> {f.label}
                  </button>
                ))}
              </div>
            )}
          </Card>

          <div className="flex justify-end">
            <Button type="button" icon={Save} loading={scopeBusy} onClick={saveScope}>
              Save scope settings
            </Button>
          </div>
        </div>
      )}

      {tab === 'integrations' && (
        <div className="space-y-8">
          <WhatsAppConnect actor={actor} />
          <MetabaseSettings actor={actor} />
        </div>
      )}
    </>
  )
}
