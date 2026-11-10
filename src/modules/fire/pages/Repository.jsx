import { useMemo, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Boxes,
  Download,
  Trash2,
  QrCode,
  AlertTriangle,
  Filter,
  Pencil,
  CheckCircle2,
  Truck,
  FileText,
  CalendarX,
  Plus,
  Upload,
  Gauge,
  PackageCheck,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Spinner } from '../components/ui'
import { TableSkeleton } from '../components/Skeleton'
import ExtinguisherTable from '../components/ExtinguisherTable'
import ReportDefectModal from '../components/ReportDefectModal'
import EditExtinguisherModal from '../components/EditExtinguisherModal'
import LinkSitesModal from '../components/LinkSitesModal'
import SubmitQuotationModal from '../components/SubmitQuotationModal'
import SubmitHptModal from '../components/SubmitHptModal'
import ReceiveFromVendorModal from '../components/ReceiveFromVendorModal'
import ListFilters from '../components/ListFilters'
import { useAuth } from '../context/AuthContext'
import { canManageAsset } from '../lib/recycle'
import RecentlyDeletedLink from '../components/RecentlyDeletedLink'
import { useFleet } from '../context/FleetContext'
import { deriveStatus, hasDateIssue } from '../lib/extinguisherLogic'
import { repositoryNextActions } from '../lib/hpt'
import { exportExtinguishers } from '../lib/exporter'
import {
  bulkDeleteExtinguishers,
  markReceivedByVendor,
  resolveDefects,
  backfillExtinguisherQr,
  linkExtinguishersToSites,
} from '../lib/data'
import { planSiteLinks } from '../lib/siteLink'
import { listLinkedAssets, filterByLinkState, siteIdSet, isLinkedToSite } from '../lib/linkedSites'
import LinkStateChips from '../components/LinkStateChips'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { emptyFilters, applyListFilters, hasActiveFilters } from '../lib/listFilter'
import { CATEGORY_LIST, PHYSICAL_DEFECT_KEYS } from '../lib/constants'
import { safeHref } from '../../../shared/safeUrl'
import { readableOnTint, solidBackground } from '../../../shared/lib/contrast'

export default function Repository() {
  const { org, extinguishers, loading, capped, loadCap } = useFleet()
  const { orgName, profile, isAdmin, isManager } = useAuth()
  const navigate = useNavigate()
  const today = useMemo(() => new Date(), [])

  // All filtering is client-side over the in-memory fleet — no queries, no
  // composite-index combinatorics, every matching row present at once.
  const [filters, setFilters] = useState(emptyFilters())
  const [activeCats, setActiveCats] = useState(new Set())
  const [onlyIssues, setOnlyIssues] = useState(false)

  // Units with a missing/invalid refill or HPT date — a data-quality problem to fix.
  const issueCount = useMemo(() => extinguishers.filter(hasDateIssue).length, [extinguishers])

  const [selected, setSelected] = useState(new Set())
  const [reportFor, setReportFor] = useState(null)
  const [quoteFor, setQuoteFor] = useState(null)
  const [hptFor, setHptFor] = useState(null)
  const [receiveFor, setReceiveFor] = useState(null)
  const [editFor, setEditFor] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const [linkTab, setLinkTab] = useState('linked')
  const [linkState, setLinkState] = useState(null)

  // Equipment came from a system with free-text site names; linking attaches
  // each asset to the site registry and takes its entity from there. Declared
  // here because the row filter below narrows by link state.
  const orgSites = useAccessibleSites()

  // Attribute filters + search (shared bar) then condition-chip narrowing.
  const visible = useMemo(() => {
    let list = applyListFilters(extinguishers, filters)
    if (activeCats.size) {
      list = list.filter((e) => {
        const cats = new Set(deriveStatus(e, today).categories)
        for (const c of activeCats) if (!cats.has(c)) return false
        return true
      })
    }
    if (onlyIssues) list = list.filter(hasDateIssue)
    list = filterByLinkState(list, orgSites, linkState)
    return list
  }, [extinguishers, filters, activeCats, onlyIssues, today, orgSites, linkState])

  // Paging is ExtinguisherTable's job now, and handing it the FULL filtered set
  // rather than a pre-cut page is what makes select-all correct.
  //
  // This page used to slice its own 20 rows and pass only those. The table's
  // header checkbox reports back the ids of whatever it was given, and
  // toggleAll below replaces the selection with them — so "select all" quietly
  // meant "select these twenty", and Delete / Export / Print QR then covered
  // twenty of however many were filtered. It also wiped any selection built up
  // across pages. Nothing said so; the count beside the toolbar just read 20.

  // ── Inline workflow actions (the realtime fleet listener refreshes rows) ──
  const sendToVendor = async (ext) => {
    setBusyId(ext.id)
    try {
      await markReceivedByVendor(orgName, ext.id, profile?.name)
      toast.success('Marked received by vendor — now In Process')
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusyId(null)
    }
  }
  const resolvePhysical = async (ext) => {
    setBusyId(ext.id)
    try {
      const remaining = (ext.physicalDefects || []).filter((k) => !PHYSICAL_DEFECT_KEYS.includes(k))
      await resolveDefects(orgName, ext.id, remaining, profile?.name)
      toast.success('Physical defects resolved')
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusyId(null)
    }
  }

  const toggleCat = (key) =>
    setActiveCats((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const toggleAll = (ids) =>
    setSelected((prev) => {
      const allOn = ids.every((id) => prev.has(id))
      return allOn ? new Set() : new Set(ids)
    })

  const selectedItems = visible.filter((e) => selected.has(e.id))

  const doExport = () => {
    const list = selected.size ? selectedItems : visible
    if (!list.length) return toast.error('Nothing to export')
    exportExtinguishers(list, `extinguishers-${Date.now()}.xlsx`, today)
    toast.success(`Exported ${list.length} rows`)
  }
  // Assets imported before the QR system carry no token, so they cannot be
  // printed or scanned until one is minted.
  const missingQr = extinguishers.filter((e) => !e.qrToken && !e.deletedAt).length

  const linkPlan = useMemo(
    () => (orgSites.length ? planSiteLinks(extinguishers, orgSites) : null),
    [extinguishers, orgSites]
  )

  // The units already attached to a site — the other half of the question the
  // link button answers, and the only half left once the linking has run.
  const linkedRows = useMemo(
    () => listLinkedAssets(extinguishers, orgSites),
    [extinguishers, orgSites]
  )

  // Counts for the link-state chips, over the whole register rather than the
  // filtered view — a chip that renumbered itself as you filtered would be
  // reporting the filter back to you.
  const linkCounts = useMemo(() => {
    const ids = siteIdSet(orgSites)
    let linked = 0
    for (const e of extinguishers) if (isLinkedToSite(e, ids)) linked += 1
    return { linked, unlinked: extinguishers.length - linked }
  }, [extinguishers, orgSites])

  const doLinkSites = async () => {
    if (!linkPlan?.linked.length) return
    setLinking(true)
    try {
      const r = await linkExtinguishersToSites(orgName, linkPlan, {
        uid: profile?.uid,
        name: profile?.name,
      })
      toast.success(`${r.linked} linked to sites · ${r.entityChanges} entity value(s) corrected`)
      setLinkOpen(false)
    } catch (err) {
      toastCaught(err, 'Could not link to sites')
    } finally {
      setLinking(false)
    }
  }

  const doGenerateQr = async () => {
    try {
      const n = await backfillExtinguisherQr(orgName, extinguishers, {
        uid: profile?.uid,
        name: profile?.name,
      })
      toast.success(
        n
          ? `QR codes generated for ${n} extinguisher(s)`
          : 'Every extinguisher already has a QR code'
      )
    } catch (err) {
      toastCaught(err, 'Could not generate QR codes')
    }
  }

  const doPrint = () => {
    const ids = selected.size ? Array.from(selected) : visible.map((e) => e.id)
    navigate('/equipment/qr-print', { state: { ids } })
  }
  const deletable = selectedItems.filter((e) => canManageAsset(profile, e, { isAdmin, isManager }))
  const doDelete = async () => {
    if (!deletable.length) {
      toast.error('None of the selected extinguishers are in your sites.')
      setConfirmDelete(false)
      return
    }
    setDeleting(true)
    try {
      const items = deletable.map((e) => ({ id: e.id, qrToken: e.qrToken }))
      await bulkDeleteExtinguishers(items, { uid: profile?.uid, name: profile?.name })
      const skipped = selectedItems.length - deletable.length
      toast.success(
        skipped
          ? `Moved ${items.length} to Recently deleted. ${skipped} ${skipped === 1 ? 'is' : 'are'} outside your sites.`
          : `Moved ${items.length} to Recently deleted`
      )
      setSelected(new Set())
      setConfirmDelete(false)
    } catch (e) {
      toastCaught(e)
    } finally {
      setDeleting(false)
    }
  }

  const filtersActive = hasActiveFilters(filters) || activeCats.size > 0 || onlyIssues

  const countLabel = loading
    ? 'Loading…'
    : `${visible.length}${filtersActive ? ` of ${extinguishers.length}` : ''} extinguisher${visible.length === 1 ? '' : 's'}${capped ? ` · showing most recent ${loadCap}` : ''}`

  return (
    <div>
      <PageHeader title="Repository" subtitle={countLabel} icon={Boxes}>
        <Link to="/equipment/add" className="btn-primary">
          <Plus size={16} /> Add extinguisher
        </Link>
        <Link to="/equipment/bulk-upload" className="btn-soft">
          <Upload size={16} /> Bulk upload
        </Link>
        <button className="btn-ghost" onClick={doExport}>
          <Download size={16} /> Export
        </button>
        <button className="btn-ghost" onClick={doPrint}>
          <QrCode size={16} /> Print QR
        </button>
        <RecentlyDeletedLink kinds={['extinguisher']} noun="extinguishers" />
        <button
          className={
            linkPlan?.linked.length ? 'btn-soft !bg-brand-100 !text-brand-800' : 'btn-ghost'
          }
          onClick={() => {
            setLinkTab(linkPlan?.linked.length ? 'pending' : 'linked')
            setLinkOpen(true)
          }}
          title="Which units are attached to a site, and which can still be matched to one"
        >
          <Boxes size={16} />
          {linkPlan?.linked.length
            ? `Link ${linkPlan.linked.length} to sites`
            : `Site links (${linkedRows.length})`}
        </button>
        {missingQr > 0 && (
          <button
            className="btn-soft !bg-amber-100 !text-amber-900"
            onClick={doGenerateQr}
            title="These assets have no QR code, so they cannot be printed or scanned"
          >
            <QrCode size={16} /> Generate {missingQr} missing QR
          </button>
        )}
      </PageHeader>

      {/* Filters (client-side; all matching rows shown at once) */}
      <ListFilters
        filters={filters}
        onChange={setFilters}
        showStatus
        searchPlaceholder="Search serial, center or type…"
      >
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
          <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400">
            <Filter size={13} /> Condition
          </span>
          {CATEGORY_LIST.map((c) => {
            const on = activeCats.has(c.key)
            return (
              <button
                key={c.key}
                onClick={() => toggleCat(c.key)}
                className="chip transition"
                style={
                  on
                    ? { backgroundColor: solidBackground(c.color), color: '#fff' }
                    : { backgroundColor: `${c.color}1a`, color: readableOnTint(c.color) }
                }
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: on ? '#fff' : c.color }}
                />
                {c.label}
              </button>
            )
          })}
          <LinkStateChips
            value={linkState}
            onChange={setLinkState}
            linkedCount={linkCounts.linked}
            unlinkedCount={linkCounts.unlinked}
          />
          {issueCount > 0 && (
            <button
              onClick={() => setOnlyIssues((v) => !v)}
              className={`chip transition ${onlyIssues ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-400/50' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'}`}
              title="Units with a missing or invalid refill/HPT date"
            >
              <CalendarX size={13} /> Date issues ({issueCount})
            </button>
          )}
        </div>
      </ListFilters>

      {/* Bulk action bar */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-canvas px-4 py-3 text-ink-900"
          >
            <span className="font-bold">{selected.size} selected</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <button className="btn bg-white/10 text-white hover:bg-white/20" onClick={doExport}>
                <Download size={15} /> Export
              </button>
              <button className="btn bg-white/10 text-white hover:bg-white/20" onClick={doPrint}>
                <QrCode size={15} /> Print QR
              </button>
              {isManager && (
                <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={15} /> Delete
                </button>
              )}
              <button
                className="btn bg-white/10 text-white hover:bg-white/20"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <TableSkeleton rows={8} cols={8} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={extinguishers.length ? 'No matches' : 'No extinguishers yet'}
          hint={
            extinguishers.length
              ? 'Try adjusting the filters above.'
              : 'Add one or bulk upload to get started.'
          }
          action={
            filtersActive ? (
              <button
                className="btn-ghost"
                onClick={() => {
                  setFilters(emptyFilters())
                  setActiveCats(new Set())
                  setOnlyIssues(false)
                }}
              >
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ExtinguisherTable
            items={visible}
            today={today}
            selectable
            selectedIds={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            showActionBy
            renderActions={(ext) => {
              // Submit HPT replaces Resolve and Send to vendor while the test
              // is due. A quotation already on the unit used to leave both of
              // those buttons up, which is how a condemned cylinder could be
              // marked handled from this list and not from the other two.
              const next = repositoryNextActions(ext, today)
              return (
                <>
                  {next.hpt && (
                    <button
                      className="btn bg-violet-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                      onClick={() => setHptFor(ext)}
                      title={`Hydrostatic test due ${ext.dateOfNextHPT || ''} — record the test and its certificate before this can move forward`}
                    >
                      <Gauge size={14} /> Submit HPT
                    </button>
                  )}
                  {next.quote && (
                    <button
                      className="btn bg-brand-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                      onClick={() => setQuoteFor(ext)}
                      title="Submit a vendor quotation before this can move forward"
                    >
                      <FileText size={14} /> Submit quotation
                    </button>
                  )}
                  {next.resolve && (
                    <button
                      className="btn bg-green-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                      disabled={busyId === ext.id}
                      onClick={() => resolvePhysical(ext)}
                      title="Resolve physical defects"
                    >
                      <CheckCircle2 size={14} /> Resolve
                    </button>
                  )}
                  {next.receive && (
                    <button
                      className="btn bg-green-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                      onClick={() => setReceiveFor(ext)}
                      title="Mark received back from the vendor"
                    >
                      <PackageCheck size={14} /> Received
                    </button>
                  )}
                  {next.send && (
                    <button
                      className="btn-soft px-2.5 py-1.5 text-xs"
                      disabled={busyId === ext.id}
                      onClick={() => sendToVendor(ext)}
                      title="Mark received by vendor (In Process)"
                    >
                      <Truck size={14} /> Send to vendor
                    </button>
                  )}
                  {(next.resolve || next.send || next.hpt) &&
                    next.quoted &&
                    (ext.quotation?.fileData || ext.quotation?.fileUrl ? (
                      <a
                        href={safeHref(ext.quotation.fileData || ext.quotation.fileUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="chip bg-cyan-50 text-cyan-700 hover:underline"
                        title={`Quoted ${ext.quotation?.amount ?? ''} · ${ext.quotation?.vendor || ''} — view document`}
                      >
                        <CheckCircle2 size={12} /> Quoted · View
                      </a>
                    ) : (
                      <span
                        className="chip bg-cyan-50 text-cyan-700"
                        title={`Quoted ${ext.quotation?.amount ?? ''} · ${ext.quotation?.vendor || ''}`}
                      >
                        <CheckCircle2 size={12} /> Quoted
                      </span>
                    ))}
                  <button
                    className="btn-ghost px-2.5 py-1.5 text-xs"
                    onClick={() => setEditFor(ext)}
                    title="Edit details"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="btn-ghost px-2.5 py-1.5 text-xs"
                    onClick={() => setReportFor(ext)}
                    title="Report defect"
                  >
                    <AlertTriangle size={14} />
                  </button>
                  <a
                    className="btn-ghost px-2.5 py-1.5 text-xs"
                    href={`/qr/${ext.qrToken}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open public QR page"
                  >
                    <QrCode size={14} />
                  </a>
                </>
              )
            }}
          />
        </>
      )}

      <LinkSitesModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        plan={linkPlan}
        linkedRows={linkedRows}
        initialTab={linkTab}
        onConfirm={doLinkSites}
        busy={linking}
      />

      <ReportDefectModal
        open={!!reportFor}
        onClose={() => setReportFor(null)}
        ext={reportFor}
       
        reporter={{ uid: profile?.uid, name: profile?.name }}
        source="portal"
      />

      <EditExtinguisherModal
        open={!!editFor}
        onClose={() => setEditFor(null)}
        ext={editFor}
       
        orgName={org?.name || orgName}
        actor={{ uid: profile?.uid, name: profile?.name }}
      />

      <SubmitQuotationModal
        open={!!quoteFor}
        onClose={() => setQuoteFor(null)}
        ext={quoteFor}
       
        orgName={org?.name || orgName}
        actor={{ uid: profile?.uid, name: profile?.name }}
      />

      <SubmitHptModal
        open={!!hptFor}
        onClose={() => setHptFor(null)}
        ext={hptFor}
       
        orgName={org?.name || orgName}
        actor={{ uid: profile?.uid, name: profile?.name }}
      />

      <ReceiveFromVendorModal
        open={!!receiveFor}
        onClose={() => setReceiveFor(null)}
        ext={receiveFor}
       
        orgName={org?.name || orgName}
        actorName={profile?.name}
      />

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete extinguishers?"
      >
        <p className="text-sm text-ink-600">
          This moves <strong>{deletable.length}</strong> extinguisher(s) to Recently deleted. They
          drop out of lists, counts and QR inspections for 30 days. Restoring brings back the same
          unit and the same QR code, so a sticker already on the cylinder works again.
          {selected.size !== deletable.length && (
            <>
              {' '}
              {selected.size - deletable.length} of the selection{' '}
              {selected.size - deletable.length === 1 ? 'is' : 'are'} outside your sites and will be
              left in place.
            </>
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={doDelete} disabled={deleting}>
            {deleting ? (
              <Spinner size={18} />
            ) : (
              <>
                <Trash2 size={16} /> Delete {selected.size}
              </>
            )}
          </button>
        </div>
      </Modal>
    </div>
  )
}
