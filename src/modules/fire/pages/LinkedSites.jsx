import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MapPin, Flame, HeartPulse, BellRing, SignpostBig, Ambulance, BriefcaseMedical, Boxes, TriangleAlert, ArrowRight } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Spinner } from '../components/ui'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { summariseLinkedSites, listLinkedAssets } from '../lib/linkedSites'
import { planAllSiteLinks } from '../lib/siteLink'
import { linkAllEquipmentToSites } from '../lib/data'
import LinkSitesModal from '../components/LinkSitesModal'

// Which registry sites the equipment is actually keyed to. The repository can
// already link unmatched units; this is the other half — what that linking has
// achieved so far, and what is still floating on a free-text name.
//
const KINDS = [
  { key: 'ext', label: 'Extinguishers', short: 'Ext', icon: Flame },
  { key: 'aed', label: 'AED', short: 'AED', icon: HeartPulse },
  { key: 'fas', label: 'Fire alarm', short: 'FAS', icon: BellRing },
  { key: 'sign', label: 'Signage', short: 'Sign', icon: SignpostBig },
  { key: 'stretcher', label: 'Stretchers', short: 'Stretcher', icon: Ambulance },
  { key: 'firstAid', label: 'First aid', short: 'First aid', icon: BriefcaseMedical },
]

function Stat({ label, value, tone = 'text-ink-900' }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-ink-400">{label}</p>
      <p className={`text-2xl font-black ${tone}`}>{value}</p>
    </div>
  )
}

const Count = ({ n }) => (n ? <span className="font-semibold text-ink-800">{n}</span> : <span className="text-ink-300">—</span>)

export default function LinkedSites() {
  const { org, extinguishers, aeds, fas, signages, stretchers, firstAid, loading } = useFleet()
  const { orgName, profile } = useAuth()
  const sites = useAccessibleSites()
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkTab, setLinkTab] = useState('pending')
  const [busy, setBusy] = useState(false)

  const summary = useMemo(
    () => summariseLinkedSites({ extinguishers, aeds, fas, signages, stretchers, firstAid }, sites),
    [extinguishers, aeds, fas, signages, stretchers, firstAid, sites]
  )
  const { linked, empty, unlinked, orphaned, totals } = summary

  // One pass over every register. Each still writes through its own function —
  // this is the reading and the decision brought together, so the same errand
  // is not run once per register in six different places.
  const plan = useMemo(
    () => (sites.length ? planAllSiteLinks({ extinguishers, aeds, fas, signages, stretchers, firstAid }, sites) : null),
    [extinguishers, aeds, fas, signages, stretchers, firstAid, sites]
  )
  const linkedRows = useMemo(() => [
    ...listLinkedAssets(extinguishers, sites).map((r) => ({ ...r, kind: 'ext' })),
    ...listLinkedAssets(aeds, sites).map((r) => ({ ...r, kind: 'aed' })),
    ...listLinkedAssets(fas, sites).map((r) => ({ ...r, kind: 'fas' })),
    ...listLinkedAssets(signages, sites).map((r) => ({ ...r, kind: 'sign' })),
    ...listLinkedAssets(stretchers, sites).map((r) => ({ ...r, kind: 'stretcher' })),
    ...listLinkedAssets(firstAid, sites).map((r) => ({ ...r, kind: 'firstAid' })),
  ], [extinguishers, aeds, fas, signages, stretchers, firstAid, sites])

  const openLink = (tab) => { setLinkTab(tab); setLinkOpen(true) }

  const doLinkAll = async () => {
    if (!plan?.total) return
    setBusy(true)
    try {
      const r = await linkAllEquipmentToSites(org?.name || orgName, plan.byKind, { uid: profile?.uid, name: profile?.name })
      if (r.linked) toast.success(`${r.linked} linked to sites · ${r.entityChanges} entity value(s) corrected`)
      // A kind that failed is named, because "some of it worked" is not an
      // outcome anyone can act on without knowing which part.
      for (const f of r.failed) toast.error(`${f.kind.toUpperCase()}: ${f.message}`)
      if (!r.failed.length) setLinkOpen(false)
    } catch (e) {
      toastCaught(e, 'Could not link to sites')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="grid place-items-center py-20"><Spinner size={28} /></div>

  return (
    <div>
      <PageHeader
        title="Sites"
        subtitle={`${totals.sitesLinked} of ${totals.sitesTotal} site${totals.sitesTotal === 1 ? '' : 's'} have equipment linked · extinguishers, AEDs, fire-alarm devices and signage`}
        icon={MapPin}
      >
        {plan?.total > 0 && (
          <button className="btn-soft !bg-brand-100 !text-brand-800" onClick={() => openLink('pending')} disabled={busy}
            title="Match every register against the site registry in one pass">
            <MapPin size={16} /> Link {plan.total} to sites
          </button>
        )}
        <button className="btn-ghost" onClick={() => openLink('linked')}>
          <Boxes size={16} /> Site links ({linkedRows.length})
        </button>
      </PageHeader>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sites with equipment" value={totals.sitesLinked} />
        <Stat label="Assets linked" value={totals.assetsLinked} />
        <Stat label="Assets not linked" value={totals.assetsUnlinked} tone={totals.assetsUnlinked ? 'text-amber-700' : 'text-ink-900'} />
        <Stat label="Sites with none" value={empty.length} tone={empty.length ? 'text-ink-500' : 'text-ink-900'} />
      </div>

      {linked.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No equipment is linked to a site yet"
          hint="Open the repository and use Link to sites to match each unit's center name against the site registry."
        />
      ) : (
        <div className="card mb-5 overflow-hidden">
          <div className="border-b border-surface-200/60 px-4 py-3">
            <p className="font-bold text-ink-900">Linked sites</p>
            <p className="text-xs text-ink-500">Counted by the stored site link, not by the name typed on the asset.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-100/60 text-left text-[11px] uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-2">Site</th>
                  <th className="px-4 py-2">Region</th>
                  <th className="px-4 py-2">Entity</th>
                  {KINDS.map((k) => <th key={k.key} className="px-4 py-2 text-right">{k.short}</th>)}
                  <th className="px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {linked.map(({ site, counts }) => (
                  <tr key={site.id} className="hover:bg-surface-100/40">
                    <td className="px-4 py-2.5 font-semibold text-ink-900">{site.name || site.id}</td>
                    <td className="px-4 py-2.5 text-ink-500">{site.region || '—'}</td>
                    <td className="px-4 py-2.5 text-ink-500">{site.entity || '—'}</td>
                    {KINDS.map((k) => <td key={k.key} className="px-4 py-2.5 text-right"><Count n={counts[k.key]} /></td>)}
                    <td className="px-4 py-2.5 text-right font-bold text-ink-900">{counts.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {unlinked.length > 0 && (
        <div className="card mb-5 overflow-hidden">
          <div className="flex items-center gap-3 border-b border-surface-200/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-bold text-ink-900">Not linked to any site</p>
              <p className="text-xs text-ink-500">
                {totals.assetsUnlinked} asset{totals.assetsUnlinked === 1 ? '' : 's'} across {unlinked.length} center
                name{unlinked.length === 1 ? '' : 's'}. These carry a typed-in name only, so they cannot be picked by site.
              </p>
            </div>
            {plan?.total > 0
              ? (
                <button className="btn-soft px-3 py-1.5 text-xs" onClick={() => openLink('pending')} disabled={busy}>
                  Link {plan.total} now <ArrowRight size={14} />
                </button>
              )
              : <Link to="/equipment/repository" className="btn-soft px-3 py-1.5 text-xs">Open register <ArrowRight size={14} /></Link>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-100/60 text-left text-[11px] uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-2">Center name on the asset</th>
                  {KINDS.map((k) => <th key={k.key} className="px-4 py-2 text-right">{k.short}</th>)}
                  <th className="px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {unlinked.map(({ centerName, counts }) => (
                  <tr key={centerName} className="hover:bg-surface-100/40">
                    <td className="px-4 py-2.5 text-ink-800">{centerName}</td>
                    {KINDS.map((k) => <td key={k.key} className="px-4 py-2.5 text-right"><Count n={counts[k.key]} /></td>)}
                    <td className="px-4 py-2.5 text-right font-bold text-ink-900">{counts.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {orphaned.length > 0 && (
        <div className="card mb-5 overflow-hidden border border-amber-200">
          <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3">
            <TriangleAlert size={18} className="text-amber-700" />
            <div>
              <p className="font-bold text-amber-900">Linked to a site that is not in your registry</p>
              <p className="text-xs text-amber-800">
                {totals.assetsOrphaned} asset{totals.assetsOrphaned === 1 ? '' : 's'} point at a site id that no longer
                exists, or one outside your site scope. Re-link them from the repository.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-100/60 text-left text-[11px] uppercase tracking-wide text-ink-400">
                <tr><th className="px-4 py-2">Site id</th><th className="px-4 py-2 text-right">Assets</th></tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {orphaned.map(({ siteId, counts }) => (
                  <tr key={siteId}>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-700">{siteId}</td>
                    <td className="px-4 py-2.5 text-right font-bold text-ink-900">{counts.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <LinkSitesModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        plan={plan?.combined}
        linkedRows={linkedRows}
        initialTab={linkTab}
        onConfirm={doLinkAll}
        busy={busy}
        noun="asset"
        nounPlural="assets"
        idLabel="ID"
        title="Equipment and their sites"
        showKind
      />

      {empty.length > 0 && (
        <div className="card p-4">
          <p className="font-bold text-ink-900">Sites with no equipment recorded</p>
          <p className="mb-3 text-xs text-ink-500">In the registry and within your scope, but nothing links to them.</p>
          <div className="flex flex-wrap gap-1.5">
            {empty.map((s) => (
              <span key={s.id} className="rounded-xl bg-surface-100 px-2.5 py-1 text-xs text-ink-600">{s.name || s.id}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
