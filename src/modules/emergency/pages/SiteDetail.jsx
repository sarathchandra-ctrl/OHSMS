import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  Map, Phone, Printer, Upload, Trash2, ImageOff, ArrowLeft, Building2, LifeBuoy, Siren,
  Layers, ChevronUp, ChevronDown, Pencil, Download,
} from 'lucide-react'
import {
  PageHeader, Card, Button, EmptyState, SkeletonCard, Modal, PrintIsolate,
} from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { subscribeOrgUsers } from '../../../shared/org/orgData'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { formatDate } from '../../../shared/lib/format'
import { erpRoleLabel } from '../../../shared/org/erpRoles'
import { useErpRoleLabels } from '../../../shared/org/useErpRoleLabels'
import { fileToDataUrl } from '../../../shared/lib/files'
import RescuePlans from '../components/RescuePlans'
import ContactsSection from '../components/ContactsSection'
import SosPoster from '../components/SosPoster'
import {
  subscribeContacts, subscribeLayouts, subscribeRescuePlans, saveFloors, deleteLayout, floorsOf, INTERNAL_ROLES,
} from '../lib/data'
import { MAX_UPLOAD_BYTES, formatSize } from '../../../shared/storage'
import { safeHref, safeSrc } from '../../../shared/safeUrl'

// Floor plans go to cloud storage. The old 900KB ceiling was the Firestore
// document limit — and layouts are the worst case for it, since SEVERAL plans
// live in one document.
const MAX_LAYOUT_BYTES = MAX_UPLOAD_BYTES

/** Escalation order; unknown roles last. */
const roleRank = (role) => {
  const i = INTERNAL_ROLES.indexOf(role)
  return i === -1 ? 99 : i
}

const SECTIONS = [
  { key: 'contacts', label: 'Contacts', icon: Phone },
  { key: 'ferp', label: 'FERP Plan', icon: Map },
  { key: 'rescue', label: 'Rescue Plans', icon: LifeBuoy },
]

export default function SiteDetail() {
  const { siteId } = useParams()
  const { actor, isManager } = useAuth()
  const roleLabels = useErpRoleLabels()
  const [contacts, setContacts] = useState(null)
  const [layouts, setLayouts] = useState({})
  const [plans, setPlans] = useState([])
  const [users, setUsers] = useState([])
  const [section, setSection] = useState('contacts')
  const [viewLayout, setViewLayout] = useState(null) // floor being enlarged
  const [sosOpen, setSosOpen] = useState(false)
  const [sosAccent, setSosAccent] = useState('pink')
  // Which sheet the next print job targets: the full site FERP, or the floor plans alone.
  const [printTarget, setPrintTarget] = useState('site')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    const u1 = subscribeContacts(setContacts)
    const u2 = subscribeLayouts(setLayouts)
    const u3 = subscribeRescuePlans(setPlans)
    const u4 = subscribeOrgUsers(setUsers)
    return () => { u1(); u2(); u3(); u4() }
  }, [])

  const siteInventory = useAccessibleSites()
  const site = useMemo(() => siteInventory.find((s) => s.id === siteId) || null, [siteInventory, siteId])
  const approvedUsers = useMemo(() => users.filter((u) => u.status === 'approved'), [users])
  const layout = site ? layouts[site.id] : null

  const siteContacts = useMemo(() => {
    if (!site) return { internal: [], external: [] }
    const mine = (contacts || []).filter((c) => !c.siteId || c.siteId === site.id)
    return {
      internal: mine
        .filter((c) => c.kind === 'internal')
        .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name)),
      external: mine.filter((c) => c.kind === 'external'),
    }
  }, [contacts, site])

  const sitePlans = useMemo(() => plans.filter((p) => p.siteId === siteId), [plans, siteId])
  // Only approved plans are live procedures — they alone print on the site FERP.
  const approvedPlans = useMemo(() => sitePlans.filter((p) => p.status === 'approved'), [sitePlans])

  const floors = useMemo(() => floorsOf(layout), [layout])

  /** Print a specific sheet: swap the isolation target, print, then restore. */
  const printSheet = (target) => {
    setPrintTarget(target)
    // Let the new PrintIsolate style commit before opening the print dialog.
    setTimeout(() => {
      window.print()
      setPrintTarget('site')
    }, 60)
  }

  // Multi-floor upload: each selected image becomes a floor, labelled in order.
  const uploadFloors = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length || !site) return
    if (files.some((f) => !f.type.startsWith('image/'))) return toast.error('Pick image files (photos or exported plans)')
    const tooBig = files.find((f) => f.size > MAX_LAYOUT_BYTES)
    if (tooBig) return toast.error(`"${tooBig.name}" is over ${formatSize(MAX_LAYOUT_BYTES)} — export a compressed JPG/PNG`)
    setBusy(true)
    try {
      const added = []
      for (const [i, file] of files.entries()) {
        added.push({
          id: `fl-${Date.now()}-${i}`,
          label: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || `Floor ${floors.length + i + 1}`,
          dataUrl: await fileToDataUrl(file),
          fileName: file.name,
        })
      }
      const next = [...floors, ...added]
      await saveFloors(site, next, actor, `Added ${added.length} floor plan(s) to ${site.name}`)
      toast.success(`${added.length} floor plan(s) added`)
    } catch (err) {
      toastCaught(err, 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const renameFloor = async (floor) => {
    const label = window.prompt('Floor name', floor.label)
    if (label == null || !label.trim()) return
    try {
      await saveFloors(site, floors.map((f) => (f.id === floor.id ? { ...f, label: label.trim() } : f)), actor,
        `Renamed a floor plan for ${site.name}`)
    } catch (err) { toastCaught(err, 'Failed') }
  }

  const moveFloor = async (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= floors.length) return
    const next = [...floors]
    ;[next[i], next[j]] = [next[j], next[i]]
    try { await saveFloors(site, next, actor, `Reordered floor plans for ${site.name}`) }
    catch (err) { toastCaught(err, 'Failed') }
  }

  const removeFloor = async (floor) => {
    if (!window.confirm(`Remove the "${floor.label}" floor plan?`)) return
    const next = floors.filter((f) => f.id !== floor.id)
    try {
      if (next.length) await saveFloors(site, next, actor, `Removed a floor plan from ${site.name}`)
      else await deleteLayout(site, actor)
      toast.success('Floor plan removed')
    } catch (err) { toastCaught(err, 'Failed') }
  }

  if (contacts === null) {
    return (
      <>
        <PageHeader title="Site emergency repository" icon={Building2} />
        <SkeletonCard className="max-w-3xl" />
      </>
    )
  }

  if (!site) {
    return (
      <>
        <PageHeader title="Site not found" icon={Building2} />
        <EmptyState
          icon={Building2}
          title="This site isn't available"
          description="It may have been removed, or you don't have access to it."
          action={<Link to="/emergency-response" className="btn-primary"><ArrowLeft size={16} /> Back to repository</Link>}
        />
      </>
    )
  }

  return (
    <>
      {/* Floor plans print landscape (they're wide drawings); the full site FERP
          sheet stays portrait for its contact tables. */}
      <PrintIsolate
        id={printTarget === 'plans' ? 'ferp-plans-sheet' : 'site-ferp-sheet'}
        landscape={printTarget === 'plans'}
      />

      <Link to="/emergency-response" className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 transition hover:text-brand-600 print:hidden">
        <ArrowLeft size={15} /> All sites
      </Link>

      <PageHeader
        title={site.name}
        subtitle={`Emergency repository — ${[site.entity, site.region].filter(Boolean).join(' · ') || 'contacts, FERP plan & rescue plans'}`}
        icon={Building2}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="soft" icon={Siren} onClick={() => setSosOpen(true)}>SOS poster</Button>
            <Button variant="soft" icon={Printer} onClick={() => printSheet('site')}>Print site FERP</Button>
          </div>
        }
      />

      {/* Section switch */}
      <div className="mb-5 flex flex-wrap gap-1.5 print:hidden">
        {SECTIONS.map((s) => {
          const count =
            s.key === 'contacts' ? siteContacts.internal.length + siteContacts.external.length
            : s.key === 'rescue' ? sitePlans.length
            : floors.length
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition ${
                section === s.key ? 'bg-brand-600 text-white shadow-elev-brand' : 'bg-surface text-ink-500 shadow-elev-sm hover:text-ink-800'
              }`}
            >
              <s.icon size={15} /> {s.label}
              <span className={`rounded-full px-1.5 text-[10px] font-bold ${section === s.key ? 'bg-white/20' : 'bg-surface-100 text-ink-500'}`}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* ── Contacts (site-scoped CRUD + nearest-services mapping) ── */}
      {section === 'contacts' && <ContactsSection site={site} contacts={contacts} users={approvedUsers} />}

      {/* ── FERP plan (evacuation layout) ── */}
      {section === 'ferp' && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-semibold text-ink-800">
              <Map size={17} className="text-accent-amber" /> FERP plan — evacuation layouts ({floors.length})
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {floors.length > 0 && (
                <Button variant="soft" icon={Download} onClick={() => printSheet('plans')}
                  title="Download the evacuation plans on their own (one floor per page)">
                  Download FERP plan
                </Button>
              )}
              {isManager && (
                <Button variant="soft" icon={Upload} loading={busy} onClick={() => fileRef.current?.click()}>
                  {floors.length ? 'Add floors' : 'Upload floor plans'}
                </Button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={uploadFloors} />
          </div>

          {floors.length > 0 ? (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                {floors.map((f, i) => (
                  <div key={f.id} className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 ">
                    <div className="mb-2 flex items-center gap-2">
                      <Layers size={14} className="shrink-0 text-accent-amber" />
                      <p className="min-w-0 flex-1 truncate font-semibold text-ink-800">{f.label}</p>
                      <div className="flex shrink-0 gap-0.5">
                        <a className="btn-ghost px-1.5 py-1 text-xs" href={safeHref(f.dataUrl)}
                          download={f.fileName || `${site.name} — ${f.label}.png`} title="Download this floor plan">
                          <Download size={13} />
                        </a>
                        {isManager && (
                          <>
                            <button className="btn-ghost px-1.5 py-1 text-xs" onClick={() => moveFloor(i, -1)} disabled={i === 0} title="Move up"><ChevronUp size={13} /></button>
                            <button className="btn-ghost px-1.5 py-1 text-xs" onClick={() => moveFloor(i, 1)} disabled={i === floors.length - 1} title="Move down"><ChevronDown size={13} /></button>
                            <button className="btn-ghost px-1.5 py-1 text-xs" onClick={() => renameFloor(f)} title="Rename floor"><Pencil size={13} /></button>
                            <button className="btn-ghost px-1.5 py-1 text-xs text-red-600 hover:bg-red-50" onClick={() => removeFloor(f)} title="Remove floor"><Trash2 size={13} /></button>
                          </>
                        )}
                      </div>
                    </div>
                    <button type="button" className="block w-full overflow-hidden rounded-xl transition hover:opacity-95"
                      onClick={() => setViewLayout(f)} title="Click to enlarge">
                      <img src={safeSrc(f.dataUrl)} alt={`${f.label} — ${site.name}`} className="max-h-[360px] w-full bg-white object-contain" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-400">
                {layout?.updatedAt?.toDate ? `Updated ${formatDate(layout.updatedAt.toDate())}` : ''}
                {layout?.updatedByName ? ` by ${layout.updatedByName}` : ''} · click any plan to enlarge
              </p>
            </>
          ) : (
            <EmptyState
              icon={ImageOff}
              title="No FERP plans uploaded"
              description={isManager
                ? 'Upload this site’s fire & emergency response plans — one image per floor (select several at once). JPG/PNG up to 2 MB each.'
                : 'The FERP plans for this site haven’t been uploaded yet — ask a manager.'}
              action={isManager && <Button icon={Upload} onClick={() => fileRef.current?.click()}>Upload floor plans</Button>}
            />
          )}
        </Card>
      )}

      {/* ── Rescue plans ── */}
      {section === 'rescue' && <RescuePlans site={site} plans={plans} users={approvedUsers} contacts={contacts || []} />}

      {sosOpen && (
        <SosPoster
          site={site}
          contacts={siteContacts.external}
          accent={sosAccent}
          onAccent={setSosAccent}
          onClose={() => setSosOpen(false)}
        />
      )}

      <Modal open={!!viewLayout} onClose={() => setViewLayout(null)} title={viewLayout ? `${viewLayout.label} — ${site.name}` : ''} size="xl">
        <div className="p-4">
          {viewLayout && <img src={safeSrc(viewLayout.dataUrl)} alt={`${viewLayout.label} — ${site.name}`} className="max-h-[75vh] w-full bg-white object-contain" />}
        </div>
      </Modal>

      {/* ── Printable FERP plans only: one floor per LANDSCAPE page ──
          Sized in mm so the drawing fills an A4 landscape sheet (281×194mm
          usable inside the 8mm @page margin) rather than depending on the
          screen viewport. */}
      <div id="ferp-plans-sheet" className="hidden bg-white text-ink-900">
        {floors.map((f, i) => (
          <div
            key={f.id}
            className="flex flex-col items-center"
            style={{ height: '188mm', ...(i > 0 ? { pageBreakBefore: 'always' } : null) }}
          >
            <div className="w-full border-b-2 border-brand-600 pb-1">
              <p className="doc-kicker">Cult Fit SMS · Emergency evacuation</p>
              <h1 className="text-[16pt] font-bold leading-tight tracking-tight">
                {site.name} — Emergency evacuation plan
              </h1>
              <p className="text-[10pt] text-ink-500">
                <span className="font-semibold text-ink-800">{f.label}</span>
                <span className="ml-2">
                  Floor {i + 1} of {floors.length}
                  {[site.entity, site.region].filter(Boolean).length ? ` · ${[site.entity, site.region].filter(Boolean).join(' · ')}` : ''}
                </span>
              </p>
            </div>
            <img src={safeSrc(f.dataUrl)} alt={f.label} className="mt-2 w-full flex-1 object-contain" style={{ minHeight: 0 }} />
          </div>
        ))}
      </div>

      {/* ── Printable site FERP: contacts + plan + rescue plans ── */}
      <div id="site-ferp-sheet" className="doc-sheet hidden p-10">
        <div className="doc-header">
          <div>
            <p className="doc-kicker">Cult Fit SMS · Fire &amp; emergency response</p>
            <h1 className="doc-title">Fire &amp; emergency response plan — {site.name}</h1>
          </div>
          <div className="doc-meta">
            <div>{[site.entity, site.region].filter(Boolean).join(' · ') || '—'}</div>
            <div className="mt-1">Printed {formatDate(new Date())}</div>
          </div>
        </div>

        <h2 className="doc-section-title">External emergency services</h2>
        <table className="doc-table mb-5">
          <tbody>
            {siteContacts.external.map((c) => (
              <tr key={c.id}>
                <td className="lbl">{c.role}</td>
                <td>
                  {c.name}
                  {(c.address || (c.distanceKm != null && c.distanceKm !== '')) && (
                    <div className="text-[10px] font-normal text-ink-500">
                      {[
                        c.distanceKm != null && c.distanceKm !== '' ? `~${c.distanceKm} km` : '',
                        c.address,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </td>
                <td className="font-mono font-semibold">{c.phone}{c.altPhone ? ` / ${c.altPhone}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="doc-section-title">Internal escalation chain</h2>
        <table className="doc-table mb-5">
          <tbody>
            {siteContacts.internal.map((c) => (
              <tr key={c.id}>
                <td className="lbl">{erpRoleLabel(c.role, roleLabels)}</td>
                <td>{c.name}</td>
                <td className="font-mono font-semibold">{c.phone}</td>
                <td>{c.email || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {floors.length > 0 && (
          <div className="mb-5">
            <h2 className="doc-section-title">
              Evacuation layouts ({floors.length} floor{floors.length === 1 ? '' : 's'})
            </h2>
            {floors.map((f, i) => (
              <div key={f.id} className="mb-4" style={i > 0 ? { pageBreakBefore: 'always' } : undefined}>
                <p className="mb-1 text-sm font-bold">{f.label}</p>
                <img src={safeSrc(f.dataUrl)} alt={f.label} className="max-h-[460px] w-full object-contain" />
              </div>
            ))}
          </div>
        )}

        {approvedPlans.length > 0 && (
          <div style={{ pageBreakBefore: 'always' }}>
            <h2 className="doc-section-title">Emergency rescue plans</h2>
            {approvedPlans.map((p) => (
              <div key={p.id} className="mb-4">
                <p className="text-sm font-black">{p.scenario} — {p.title}</p>
                {p.assemblyPoint && <p className="text-xs">Assembly point: {p.assemblyPoint}</p>}
                {p.triggers && <p className="text-xs">Activate when: {p.triggers}</p>}
                <ol className="ml-5 mt-1 list-decimal text-sm">
                  {(p.steps || []).map((s) => (
                    <li key={s.id}>{s.action}{s.responsible ? ` — ${s.responsible}` : ''}</li>
                  ))}
                </ol>
                {(p.team || []).length > 0 && (
                  <p className="mt-1 text-xs"><b>Rescue team:</b> {p.team.map((t) => `${t.role ? t.role + ': ' : ''}${t.name}${t.phone ? ' (' + t.phone + ')' : ''}`).join(' · ')}</p>
                )}
                {(p.equipment || []).length > 0 && <p className="text-xs"><b>Equipment:</b> {p.equipment.join(', ')}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
