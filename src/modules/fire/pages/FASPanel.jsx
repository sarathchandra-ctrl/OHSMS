import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, BellRing, QrCode } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, Badge, Spinner, EmptyState } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { generateFasQr, getFas } from '../lib/firestore'
import { isFasControlPanel } from '../lib/fasQr'
import { FAS_STATUS_COLOR, FAS_STATUS_LABEL } from '../lib/constants'
import FasQrCard from '../components/FasQrCard'

const Row = ({ label, value }) => (
  <div className="grid grid-cols-1 gap-1 border-b border-surface-200/70 py-2.5 sm:grid-cols-[10rem_1fr] sm:gap-3">
    <dt className="text-sm text-ink-500">{label}</dt>
    <dd className="text-sm font-semibold text-ink-900">{value || '—'}</dd>
  </div>
)

/**
 * One fire-alarm control panel.
 *
 * The list is where a panel is added. This is where its QR code lives: the
 * same code the register exports, downloadable and printable, encoding the
 * public page a scan opens. A panel created before codes were assigned on
 * create has none until an admin generates one — that write reuses a token
 * if one is already stored.
 */
export default function FASPanel() {
  const { id } = useParams()
  const { orgName, profile, isAdmin } = useAuth()
  const { fas, loading } = useFleet()
  const listed = fas.find((a) => a.id === id) || null
  const [fetched, setFetched] = useState(undefined)
  const [forId, setForId] = useState(id)
  const [minted, setMinted] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (loading || listed) return undefined
    if ((!id)) {
      setFetched(null)
      setForId(id)
      return undefined
    }
    let alive = true
    setFetched(undefined)
    setForId(id)
    getFas(id)
      .then((row) => { if (alive) setFetched(row) })
      .catch(() => { if (alive) setFetched(null) })
    return () => { alive = false }
  }, [loading, listed, id])

  const loaded = listed || (forId === id ? fetched : undefined)
  const panel = loaded ? { ...loaded, qrToken: loaded.qrToken || minted } : loaded

  const generate = async () => {
    if (!panel || busy) return
    setBusy(true)
    try {
      const token = await generateFasQr(orgName, panel, { uid: profile?.uid, name: profile?.name })
      setMinted(token)
      toast.success('QR code generated')
    } catch (err) {
      toastCaught(err, 'Could not generate a QR code')
    } finally {
      setBusy(false)
    }
  }

  if (loading || panel === undefined) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner size={28} />
      </div>
    )
  }

  if (!panel) {
    return (
      <div>
        <Link to="/equipment/fas" className="btn-ghost mb-4">
          <ArrowLeft size={16} /> Back to FAS repository
        </Link>
        <EmptyState
          icon={BellRing}
          title="Panel not found"
          hint="It may have been removed, or it belongs to another organisation."
        />
      </div>
    )
  }

  const name = panel.deviceId || panel.deviceType || 'FAS device'
  const panelQr = isFasControlPanel(panel)

  return (
    <div>
      <PageHeader
        title={name}
        subtitle={[panel.deviceType, panel.centerName].filter(Boolean).join(' · ')}
        icon={BellRing}
      >
        <Link to="/equipment/fas" className="btn-ghost">
          <ArrowLeft size={16} /> FAS repository
        </Link>
      </PageHeader>

      {panel.deletedAt && (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This device is in Recently deleted. Its QR sticker stays dark until it is restored.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="card p-5">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wide text-ink-400">Device</h2>
            <Badge color={FAS_STATUS_COLOR[panel.status] || '#64748b'}>
              {FAS_STATUS_LABEL[panel.status] || panel.status || 'Unknown'}
            </Badge>
          </div>
          <dl>
            <Row label="Device ID" value={panel.deviceId} />
            <Row label="Type" value={panel.deviceType} />
            <Row label="Site" value={panel.centerName} />
            <Row label="Region" value={panel.region} />
            <Row label="Entity" value={panel.entity} />
            <Row label="Zone / loop" value={panel.zone} />
            <Row label="Location" value={panel.location} />
            <Row label="Install date" value={panel.installDate} />
            <Row label="Last service" value={panel.lastService} />
            <Row label="Next service" value={panel.nextService} />
            <Row label="AMC vendor" value={panel.amcVendor} />
            <Row label="Notes" value={panel.notes} />
          </dl>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-ink-400">
            <QrCode size={14} /> QR code
          </h2>
          {panel.qrToken ? (
            <FasQrCard panel={panel} />
          ) : panelQr ? (
            <div className="text-sm text-ink-600">
              <p>This control panel has no QR code yet, so nothing can be printed and a scan has no page to open.</p>
              {isAdmin ? (
                <button type="button" className="btn-primary mt-4" onClick={generate} disabled={busy}>
                  {busy ? <Spinner size={16} /> : <QrCode size={16} />} Generate QR code for {name}
                </button>
              ) : (
                <p className="mt-2 text-ink-500">An administrator can generate one from the FAS repository.</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-600">
              QR codes are issued for control panels. This {panel.deviceType || 'device'} is covered by the panel at its site.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
