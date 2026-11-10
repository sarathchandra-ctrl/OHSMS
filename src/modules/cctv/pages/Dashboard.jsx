import { Link } from 'react-router-dom'
import { Download, Cctv, HardDrive, Router, TriangleAlert } from 'lucide-react'
import { PageHeader, Button, EmptyState, SkeletonTable } from '../../../shared/ui'
import { useCctv } from '../context/CctvContext'
import { downloadHealth } from '../lib/exporter'
import { CAUSE } from '../lib/constants'
import { Stat, HealthPill, StatusChip } from '../components/ui'

/**
 * The estate at a glance.
 *
 * The headline is camera uptime, but the number directly under it is the split
 * by cause — because "38 of 120 cameras offline" and "38 offline, all of them
 * behind one dead switch" are the same number and completely different days.
 */
export default function Dashboard() {
  const { estate, orgName, loading, error, cameras, dvrs, merakis } = useCctv()
  const { cameraSummary: cs, dvrSummary: ds, merakiSummary: ms } = estate

  if (error) {
    return (
      <>
        <PageHeader title="CCTV Health" icon={Cctv} />
        <EmptyState
          icon={TriangleAlert}
          title="Could not load the CCTV estate"
          hint="The list below is not empty because there are no cameras — it failed to load. Refresh, and if it persists check your connection."
        />
      </>
    )
  }

  if (loading) {
    return (
      <>
        <PageHeader title="CCTV Health" icon={Cctv} />
        <SkeletonTable rows={6} />
      </>
    )
  }

  const empty = !cameras.length && !dvrs.length && !merakis.length
  if (empty) {
    return (
      <>
        <PageHeader title="CCTV Health" icon={Cctv} />
        <EmptyState
          icon={Cctv}
          title="No CCTV equipment yet"
          hint="Add your Meraki devices first, then the DVRs they carry, then the cameras on each DVR — health is calculated down that chain."
          action={<Link to="/cctv/inventory"><Button>Open inventory</Button></Link>}
        />
      </>
    )
  }

  const upstream = cs.byCause[CAUSE.DVR] + cs.byCause[CAUSE.MERAKI]

  return (
    <>
      <PageHeader
        title="CCTV Health"
        icon={Cctv}
        subtitle={`${cs.total} cameras · ${ds.total} DVR · ${ms.total} Meraki`}
        actions={
          <Button variant="ghost" icon={Download} onClick={() => downloadHealth(estate, { orgName })}>
            Health report
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cameras" value={cs.total} sub={`${cs.online} online · ${cs.offline} offline`} />
        <Stat
          label="Camera uptime"
          value={`${cs.uptime}%`}
          sub={cs.band.label}
          tone={cs.uptime >= 95 ? 'emerald' : cs.uptime >= 80 ? 'amber' : 'red'}
        />
        {/* An unreported device counts as working so a newly-added row does not
            tank the estate figure — but saying "5/5 online" about five devices
            nobody has checked is a green number that was never earned. Where
            that is what the count is made of, say so instead. */}
        <Stat
          label="DVR online"
          value={`${ds.online}/${ds.total}`}
          sub={ds.unknown ? `${ds.unknown} not reported` : `${ds.uptime}% · ${ds.band.label}`}
          tone={ds.unknown === ds.total && ds.total > 0 ? 'amber' : 'ink'}
        />
        <Stat
          label="Meraki online"
          value={`${ms.online}/${ms.total}`}
          sub={ms.unknown ? `${ms.unknown} not reported` : `${ms.uptime}% · ${ms.band.label}`}
          tone={ms.unknown === ms.total && ms.total > 0 ? 'amber' : 'ink'}
        />
      </div>

      {/* The distinction the whole module exists for. */}
      {cs.offline > 0 && (
        <div className="card mt-4 p-4">
          <div className="text-sm font-semibold text-ink-800">Why cameras are offline</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Camera at fault"
              value={cs.byCause[CAUSE.SELF]}
              sub="Needs a visit to the camera"
              tone={cs.byCause[CAUSE.SELF] ? 'red' : 'ink'}
            />
            <Stat
              label="DVR down"
              value={cs.byCause[CAUSE.DVR]}
              sub="Cameras are fine — fix the DVR"
              tone={cs.byCause[CAUSE.DVR] ? 'amber' : 'ink'}
            />
            <Stat
              label="Meraki down"
              value={cs.byCause[CAUSE.MERAKI]}
              sub="Cameras are fine — fix the network"
              tone={cs.byCause[CAUSE.MERAKI] ? 'amber' : 'ink'}
            />
          </div>
          {upstream > 0 && (
            <p className="mt-3 text-xs text-ink-500">
              {upstream} of {cs.offline} offline cameras are not faulty — they are dark because something
              above them is down. They are excluded from the camera defect export.
            </p>
          )}
        </div>
      )}

      {cs.impaired > 0 && (
        <div className="card mt-4 flex items-start gap-2.5 p-4 text-sm text-amber-800">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            <b>{cs.impaired}</b> camera{cs.impaired === 1 ? ' is' : 's are'} streaming but not usable — blurred,
            blocked or badly angled. An uptime figure alone would call {cs.impaired === 1 ? 'it' : 'them'} healthy.
          </span>
        </div>
      )}

      {cs.orphans > 0 && (
        <div className="card mt-4 flex items-start gap-2.5 p-4 text-sm text-ink-600">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <span>
            <b>{cs.orphans}</b> camera{cs.orphans === 1 ? '' : 's'} point at a DVR that is not in the inventory,
            so {cs.orphans === 1 ? 'its' : 'their'} health cannot be judged. Fix the DVR link on those records.
          </span>
        </div>
      )}

      {/* Sites, worst first. */}
      <section className="mt-6">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-ink-800">
          <Router size={15} /> Sites
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2">Cameras</th>
                <th className="px-3 py-2">Online</th>
                <th className="px-3 py-2">DVR</th>
                <th className="px-3 py-2">Meraki</th>
                <th className="px-3 py-2">Camera uptime</th>
              </tr>
            </thead>
            <tbody>
              {estate.siteReport.map((s) => (
                <tr key={s.siteId || s.siteName} className="border-t border-ink-100">
                  <td className="px-3 py-2 font-medium text-ink-800">{s.siteName}</td>
                  <td className="px-3 py-2">{s.cameras}</td>
                  <td className="px-3 py-2">{s.camerasOnline}</td>
                  <td className="px-3 py-2">{s.dvrsOnline}/{s.dvrs}</td>
                  <td className="px-3 py-2">{s.merakisOnline}/{s.merakis}</td>
                  <td className="px-3 py-2"><HealthPill pct={s.cameraUptime} band={s.band} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Per-DVR, which is the report a CCTV contractor actually works from. */}
      <section className="mt-6">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-ink-800">
          <HardDrive size={15} /> DVR health
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-3 py-2">DVR</th>
                <th className="px-3 py-2">IP address</th>
                <th className="px-3 py-2">Site</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Cameras</th>
                <th className="px-3 py-2">Uptime</th>
              </tr>
            </thead>
            <tbody>
              {estate.dvrReport.map((d) => (
                <tr key={d.id} className="border-t border-ink-100">
                  <td className="px-3 py-2 font-medium text-ink-800">{d.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.ipAddress || '—'}</td>
                  <td className="px-3 py-2">{d.siteName || '—'}</td>
                  <td className="px-3 py-2"><StatusChip health={d} /></td>
                  <td className="px-3 py-2">{d.camerasOnline}/{d.cameras}</td>
                  <td className="px-3 py-2"><HealthPill pct={d.cameraUptime} band={d.band} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
