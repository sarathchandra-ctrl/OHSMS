import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../shared/lib/toastCaught'
import {
  Building2, CheckCircle2, ChevronRight, CircleDashed, ExternalLink, Eye,
  File as FileIcon, FolderPlus, Folder as FolderIcon, Landmark, Link2,
  ListChecks, MapPin, MoreVertical, Pencil, Plus, Rocket, Search, Trash2, Upload,
} from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import { can } from '../../shared/auth/permissions'
import { safeHref } from '../../shared/safeUrl'
import { putFile } from '../../shared/storage'
import { Badge, Button, Field, Input, Modal, PageHeader, EmptyState, SkeletonCard } from '../../shared/ui'
import { formatDate, isOverdue } from '../../shared/lib/format'
import { useAccessibleSites } from '../../shared/org/useAccessibleSites'
import { MODULE_BY_KEY } from '../../shared/modules/registry'
import { documentsService } from './lib/service'
import { documentFolderService } from './lib/folderService'
import {
  docTypeTone, docTypeLabel, documentHref, documentLabel, hasDocument, SOURCE_LINK,
} from './lib/docTypes'
import {
  MAX_DEPTH, PRE_LAUNCH, breadcrumbOf, buildTree, childrenOf, countTree, filesIn,
  folderNameError, manualDepth, nodeAt, prelaunchCategoryOf, resolveNode, rootsOf,
  siblingsOf, storageFolder, subtreeOf,
} from './lib/tree'
import { PRE_LAUNCH_TOTAL, prelaunchReadiness } from './lib/prelaunch'
import DocumentDialog from './DocumentDialog'

const module = MODULE_BY_KEY.documents

// ─────────────────────────────────────────────────────────────────────────────
// The document library, as a file browser.
//
// The skeleton is DERIVED from the site registry — Org Level Documents, then a
// folder per region, per entity within it, per site within that, and a Pre
// Launch and Others pair under each site. Nobody creates those; they appear
// because the registry says those places exist, and an empty one is the finding
// an audit is looking for. Free-form subfolders live inside the two buckets and
// inside Org Level Documents, which is where organising by hand actually helps.
//
// What makes this safe rather than merely tidy: the FOLDER decides the
// classification. Filing into a site's Pre Launch folder makes the document
// that site's, in the tree and in firestore.rules at the same time, from the
// same fields. There is no second setting that can quietly disagree with where
// a document appears to be.
// ─────────────────────────────────────────────────────────────────────────────

// Each kind of node reads differently at a glance — a region is not a site is
// not a bucket — so the icon carries that rather than making people read.
const NODE_ICON = {
  org: Landmark,
  region: MapPin,
  entity: Building2,
  site: FolderIcon,
  bucket: FolderIcon,
  prelaunch: ListChecks,
  manual: FolderIcon,
  unfiled: FolderIcon,
}

const NODE_TONE = {
  org: 'text-brand-500',
  region: 'text-blue-500',
  entity: 'text-violet-500',
  site: 'text-ink-400',
  bucket: 'text-ink-400',
  prelaunch: 'text-brand-500',
  manual: 'text-ink-400',
  unfiled: 'text-amber-500',
}

// ── Readiness ────────────────────────────────────────────────────────────────
//
// Green only at 100%. A handover pack that is 34 of 35 is not nearly done, it
// is not done, and a bar that has gone green at 97% stops anybody reading the
// number beside it.

const readyTone = (r) => (r.complete ? 'bg-emerald-500' : r.ready ? 'bg-amber-500' : 'bg-surface-200')

function ReadinessBar({ readiness, className = '' }) {
  return (
    <span
      role="img"
      aria-label={`${readiness.pct}% ready — ${readiness.ready} of ${readiness.total} documents attached`}
      className={`block h-1.5 w-full overflow-hidden rounded-full bg-surface-100 ${className}`}
    >
      <span
        className={`block h-full rounded-full transition-[width] ${readyTone(readiness)}`}
        style={{ width: `${readiness.pct}%` }}
      />
    </span>
  )
}

/**
 * The banner over a Pre Launch folder: how much of the handover pack exists.
 *
 * `stub` gets its own sentence because it is the failure nobody chases — a row
 * with a record against it reads as done on any count of records, and produces
 * nothing on the day.
 */
function ReadinessPanel({ title, subtitle, readiness }) {
  return (
    <div className="card mb-4 px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13px] font-bold text-ink-900">{title}</p>
        <p className="text-[13px] font-bold text-ink-900">
          {readiness.pct}%
          <span className="ml-1.5 text-[12px] font-semibold text-ink-400">
            {readiness.ready} of {readiness.total} ready
          </span>
        </p>
      </div>
      <ReadinessBar readiness={readiness} className="mt-2" />
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
        {subtitle}
        {readiness.stub > 0 && (
          <span className="font-semibold text-amber-700">
            {' '}{readiness.stub} row{readiness.stub === 1 ? ' has' : 's have'} a record with nothing
            attached — those count as missing.
          </span>
        )}
      </p>
    </div>
  )
}

// ── A tile's kebab ───────────────────────────────────────────────────────────

/**
 * The per-tile menu. Closes on an outside click and on Escape, because a menu
 * that only closes by choosing something makes people choose something.
 */
function TileMenu({ label, items }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const usable = items.filter(Boolean)
  if (!usable.length) return null

  return (
    <div ref={box} className="relative flex-none">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className="rounded-lg p-1.5 text-ink-400 transition hover:bg-surface-100 hover:text-ink-700"
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-ink-100 bg-white py-1 shadow-lg">
          {usable.map((it) => (
            <button
              key={it.label}
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick() }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold transition hover:bg-surface-100 ${
                it.danger ? 'text-red-600' : 'text-ink-700'
              }`}
            >
              <it.icon size={15} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Tiles ────────────────────────────────────────────────────────────────────

const TILE = 'group card flex items-center gap-3 p-3 text-left transition hover:shadow-elev'

function FolderTile({ node, count, readiness, onOpen, menu }) {
  // Pre Launch earns its own icon: it is the one folder whose contents are
  // time-bound, and it is the one people are told to go and fill.
  const Icon = node.kind === 'bucket' && node.id.endsWith(PRE_LAUNCH)
    ? Rocket
    : NODE_ICON[node.kind] || FolderIcon

  return (
    <div className={TILE}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3">
        <Icon size={22} className={`flex-none ${NODE_TONE[node.kind] || 'text-ink-400'}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-ink-900">{node.name}</span>
          {/* A folder measured against a checklist reports the checklist, not a
              count. "7 documents" in a folder that owes 12 is the number that
              lets a handover through. */}
          {readiness ? (
            <>
              <span className="block text-xs font-semibold text-ink-500">
                {readiness.ready} of {readiness.total} ready
              </span>
              <ReadinessBar readiness={readiness} className="mt-1.5" />
            </>
          ) : (
            // A folder holding nothing is the finding an audit is looking for,
            // so the zero is shown and greyed rather than hidden.
            <span className={`block text-xs font-semibold ${count ? 'text-ink-500' : 'text-ink-300'}`}>
              {count} document{count === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </button>
      {menu}
    </div>
  )
}

/**
 * One row of the handover checklist, whether or not anything satisfies it yet.
 *
 * The empty version is the entire point of the checklist existing. A library
 * can only ever show you what somebody uploaded; this shows what nobody did,
 * which is the half a handover review is actually asking about.
 */
function ChecklistTile({ row, canWrite, onOpen, onFill, menu }) {
  const { item, doc, ready } = row
  const Icon = ready ? CheckCircle2 : CircleDashed
  const tone = ready ? 'text-emerald-600' : doc ? 'text-amber-500' : 'text-ink-300'

  return (
    <div className={TILE}>
      <button
        type="button"
        // Nothing to open and nothing this viewer may add: the row is there to
        // be READ, and a click that silently does nothing reads as broken.
        disabled={!doc && !canWrite}
        onClick={doc ? onOpen : onFill}
        className="flex min-w-0 flex-1 items-start gap-3 disabled:cursor-default"
      >
        <Icon size={22} className={`mt-0.5 flex-none ${tone}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold leading-snug text-ink-900">
            <span className="text-ink-400">{item.no}</span> {doc?.title || item.title}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={ready ? 'green' : doc ? 'amber' : 'gray'}>
              {ready ? 'Ready' : doc ? 'No file yet' : 'Not filed'}
            </Badge>
            <span className="text-xs font-semibold text-ink-400">{item.owner}</span>
            <span className="text-xs text-ink-400">·</span>
            <span className="text-xs font-semibold text-ink-400">{item.timeline}</span>
          </span>
          {/* The schedule's own Ref. Doc note, where it says something beyond
              "a link goes here" — which is what the empty row already is. */}
          {item.note && (
            <span className="mt-1 block text-[11px] leading-relaxed text-ink-400">{item.note}</span>
          )}
        </span>
      </button>
      {doc ? menu : canWrite && (
        <Button variant="soft" icon={Plus} className="flex-none !px-3" onClick={onFill}>
          Add
        </Button>
      )}
    </div>
  )
}

function FileTile({ doc, onOpen, menu }) {
  const isLink = doc.source === SOURCE_LINK
  const Icon = isLink ? Link2 : FileIcon
  const openable = hasDocument(doc)
  const due = isOverdue(doc.reviewDate)

  return (
    <div className={TILE}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3">
        <Icon size={22} className={`flex-none ${openable ? 'text-brand-600' : 'text-ink-300'}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-ink-900">
            {doc.title || '(untitled)'}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={docTypeTone(doc.docType)}>{doc.docType || '—'}</Badge>
            {doc.version && <span className="text-xs font-semibold text-ink-400">v{doc.version}</span>}
            {due && <span className="text-xs font-bold text-red-600">Review overdue</span>}
            {/* A record carrying neither an upload nor a link is a stub. Saying
                so on the tile beats a click that silently does nothing. */}
            {!openable && <span className="text-xs font-semibold text-amber-600">No file yet</span>}
          </span>
        </span>
      </button>
      {menu}
    </div>
  )
}

// ── Naming a folder ──────────────────────────────────────────────────────────

function FolderDialog({ open, mode, initial, siblings, exceptId, busy, onClose, onSubmit }) {
  const [name, setName] = useState(initial || '')
  const error = name === '' ? '' : folderNameError(name, siblings, exceptId)

  // Focus the field, and do it from HERE rather than with `autoFocus`.
  //
  // Modal's focus trap moves focus to the first focusable descendant on open,
  // and in this dialog that is the header's Close button — so React's autoFocus
  // was applied during commit and then immediately overridden. The dialog then
  // invited you to type into a field that was not focused, and the first SPACE
  // in the name activated the focused Close button and threw the dialog away.
  //
  // This wins because effects run child-first: Modal is our child, so its trap
  // has already had its turn by the time this runs.
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'rename' ? 'Rename folder' : 'New folder'}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="folder-form" disabled={busy || Boolean(error) || !name.trim()}>
            {busy ? 'Saving…' : mode === 'rename' ? 'Rename' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="folder-form" onSubmit={(e) => { e.preventDefault(); onSubmit(name.trim()) }}>
        <Field label="Folder name" htmlFor="folder-name" error={error}>
          <Input
            ref={inputRef}
            id="folder-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Fire drawings"
          />
        </Field>
      </form>
    </Modal>
  )
}

// ── Details ──────────────────────────────────────────────────────────────────

const Row = ({ label, children }) =>
  children ? (
    <div className="flex gap-3 border-b border-ink-100 py-2 last:border-0">
      <span className="w-36 flex-none text-xs font-bold uppercase tracking-wide text-ink-400">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-ink-800">{children}</span>
    </div>
  ) : null

function DetailsDialog({ doc, path, onClose }) {
  const href = documentHref(doc)
  return (
    <Modal
      open={Boolean(doc)}
      onClose={onClose}
      title={doc?.title || 'Document'}
      subtitle={path}
      size="md"
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <div>
        <Row label="Type">{docTypeLabel(doc.docType)}</Row>
        <Row label="Opens">
          {href ? (
            <a
              href={safeHref(href)}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:underline"
            >
              {doc.source === SOURCE_LINK ? <ExternalLink size={13} /> : <FileIcon size={13} />}
              {documentLabel(doc) || 'Open'}
            </a>
          ) : (
            <span className="text-amber-600">Nothing attached yet</span>
          )}
        </Row>
        <Row label="Version">{doc.version}</Row>
        <Row label="Owner">{doc.owner}</Row>
        <Row label="Reference no.">{doc.reference}</Row>
        <Row label="Effective">{formatDate(doc.effectiveDate)}</Row>
        <Row label="Review due">
          {doc.reviewDate && (
            <span className={isOverdue(doc.reviewDate) ? 'font-semibold text-red-600' : ''}>
              {formatDate(doc.reviewDate)}
            </span>
          )}
        </Row>
        <Row label="Visible to">
          {doc.visibility === 'site' ? `${doc.site || 'One site'} only` : 'Everyone in the organization'}
        </Row>
        <Row label="Notes">{doc.summary}</Row>
      </div>
    </Modal>
  )
}

// ── The browser ──────────────────────────────────────────────────────────────

export default function DocumentsModule() {
  const { actor, role, isManager } = useAuth()
  const sites = useAccessibleSites()

  const [docs, setDocs] = useState(null) // null = loading
  const [folders, setFolders] = useState([])
  const [nodeId, setNodeId] = useState('') // '' = the top of the tree
  const [search, setSearch] = useState('')
  const [docDialog, setDocDialog] = useState(null) // { mode, doc, seed }
  const [folderDialog, setFolderDialog] = useState(null) // { mode, folder }
  const [details, setDetails] = useState(null)
  const [busy, setBusy] = useState(false)

  const canWrite = can(role, 'record.create')
  const viewer = useMemo(() => ({ role, sites }), [role, sites])

  useEffect(() => {
    setDocs(null)
    return documentsService.subscribe(setDocs, viewer)
  }, [viewer])

  useEffect(() => {
    return documentFolderService.subscribe(setFolders)
  }, [])

  // Memoised so the fresh [] a loading library produces cannot re-run every
  // derivation below it on every render.
  const records = useMemo(() => docs || [], [docs])
  const tree = useMemo(
    () => buildTree({ sites, folders, docs: records }),
    [sites, folders, records]
  )
  // Only the rolled-up totals are wanted: what sits directly in a folder is
  // counted below, after the checklist rows have been taken out of it.
  const { total } = useMemo(() => countTree(records, tree), [records, tree])

  const node = nodeId ? nodeAt(tree, nodeId) : null
  const atTop = !node

  const childIds = useMemo(
    () => (atTop ? rootsOf(tree) : childrenOf(tree, nodeId)),
    [atTop, tree, nodeId]
  )
  const here = useMemo(
    () => (atTop ? [] : filesIn(records, tree, nodeId)),
    [atTop, records, tree, nodeId]
  )
  const trail = useMemo(() => (atTop ? [] : breadcrumbOf(tree, nodeId)), [atTop, tree, nodeId])

  // ── The handover checklist ─────────────────────────────────────────────────
  //
  // Measured against the SITE, not against the folder. A certificate filed into
  // Pre Launch itself, or into somebody's subfolder inside a category, still
  // satisfies the row it names — the checklist asks whether the site can
  // produce the document, and where it was filed is a tidiness question.
  const siteDocs = useMemo(
    () => (node?.siteId ? records.filter((d) => d && d.siteId === node.siteId) : []),
    [records, node?.siteId]
  )
  const readiness = useMemo(
    () => (node?.siteId ? prelaunchReadiness(siteDocs) : null),
    [node?.siteId, siteDocs]
  )

  const isPreLaunch = node?.kind === 'bucket' && node.id.endsWith(PRE_LAUNCH)
  const categoryKey = prelaunchCategoryOf(node)
  const category = categoryKey && readiness
    ? readiness.byCategory.find((c) => c.key === categoryKey) || null
    : null

  /** The readiness to show on a child tile, or null when it is not measured. */
  const readinessFor = (child) => {
    if (!readiness) return null
    if (child.kind === 'prelaunch') {
      return readiness.byCategory.find((c) => c.key === child.categoryKey) || null
    }
    if (child.kind === 'bucket' && child.id.endsWith(PRE_LAUNCH)) return readiness
    return null
  }

  // Inside a category, the checklist rows ARE the documents — listing them a
  // second time underneath would show the same certificate twice, once as a
  // satisfied row and once as a file.
  const listed = useMemo(
    () => new Set((category?.rows || []).map((r) => r.doc?.id).filter(Boolean)),
    [category]
  )
  const loose = useMemo(() => here.filter((d) => !listed.has(d.id)), [here, listed])

  // A node that stops existing — a site removed from the registry, a folder
  // deleted — would otherwise leave the browser parked somewhere that is not
  // there, with no breadcrumb back. The top is the one always-valid destination.
  useEffect(() => {
    if (nodeId && docs !== null && !tree.nodes.has(nodeId)) setNodeId('')
  }, [tree, nodeId, docs])

  /** Where a document lives, spelled out — for search results and details. */
  const pathOf = (doc) =>
    breadcrumbOf(tree, resolveNode(doc, tree)).map((n) => n.name).join(' / ')

  const results = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    return records.filter((r) => {
      const hay = [r.title, r.docType, r.owner, r.reference, r.summary, r.version, r.file?.name, r.linkUrl]
      return hay.some((v) => String(v || '').toLowerCase().includes(q))
    })
  }, [search, records])

  const go = (id) => { setNodeId(id || ''); setSearch('') }

  const openDoc = (doc) => {
    const href = documentHref(doc)
    // A record with neither an upload nor a link still goes somewhere: its
    // details. A tile that silently does nothing reads as broken.
    if (!href) return setDetails(doc)
    return window.open(safeHref(href), '_blank', 'noopener,noreferrer')
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * The upload happens HERE, immediately before the record is written.
   *
   * The file field defers rather than uploading when it is picked, because
   * bytes in the bucket with no record pointing at them are unreachable AND
   * undeletable — storage.rules refuses every client delete, so an abandoned
   * form used to strand a file permanently. Six of them accumulated in a single
   * afternoon of testing.
   *
   * This does not make the pair atomic: an upload that succeeds followed by a
   * write that fails still strands one. It shrinks the window from "as long as
   * the dialog is open" to the moment between the two calls, which is as far as
   * a client can get without a server-side transaction.
   */
  const saveDoc = async (payload, error) => {
    if (error) return toast.error(error.message)
    setBusy(true)
    try {
      const record = { ...payload }
      if (record.file instanceof File) {
        const stored = await putFile(
          storageFolder(tree, record.folderId), record.file, record.file.name
        )
        // putFile returns null for every failure — no bucket, rules refusal,
        // offline. Throwing here means no record is written claiming a file
        // that is not there.
        if (!stored) throw new Error('The file could not be uploaded — nothing was saved')
        record.file = stored
      }

      const label = record.title || '(untitled)'
      if (docDialog.mode === 'edit') {
        const { id: _id, createdAt: _createdAt, __node: _n, ...rest } = record
        await documentsService.update(docDialog.doc.id, rest, actor, label)
        toast.success('Document updated')
      } else {
        await documentsService.create({ ...record, status: 'draft' }, actor, label)
        toast.success('Document added')
      }
      setDocDialog(null)
    } catch (err) {
      toastCaught(err, 'Save failed')
    } finally {
      setBusy(false)
    }
    return undefined
  }

  const deleteDoc = async (doc) => {
    if (!window.confirm(`Delete "${doc.title || 'this document'}"? This cannot be undone.`)) return
    try {
      await documentsService.remove(doc.id, actor, doc.title || '')
      toast.success('Document deleted')
      setDetails(null)
    } catch (err) {
      toastCaught(err, 'Delete failed')
    }
  }

  const saveFolder = async (name) => {
    setBusy(true)
    try {
      if (folderDialog.mode === 'rename') {
        await documentFolderService.rename(folderDialog.folder.stored, name, actor)
        toast.success('Folder renamed')
      } else {
        await documentFolderService.create({ name, parentId: nodeId }, actor)
        toast.success('Folder created')
      }
      setFolderDialog(null)
    } catch (err) {
      toastCaught(err, 'Could not save the folder')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Deleting a folder refuses while anything is inside it, at any depth.
   *
   * There is no recursive delete and no trash. A folder is cheap to recreate
   * and its contents are not, so the destructive version of this operation is
   * simply not offered — the message says what is in the way instead.
   */
  const deleteFolder = async (target) => {
    const inside = total.get(target.id) || 0
    const nested = subtreeOf(tree, target.id).size - 1
    if (inside || nested) {
      return toast.error(
        `"${target.name}" still holds ${inside} document${inside === 1 ? '' : 's'}` +
        `${nested ? ` and ${nested} subfolder${nested === 1 ? '' : 's'}` : ''}. Empty it first.`
      )
    }
    if (!window.confirm(`Delete the folder "${target.name}"?`)) return undefined
    try {
      await documentFolderService.remove(target.stored, actor)
      toast.success('Folder deleted')
    } catch (err) {
      toastCaught(err, 'Delete failed')
    }
    return undefined
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const canFileHere = canWrite && Boolean(node?.filable)
  const canFolderHere = canWrite && Boolean(node?.canAddFolder)
  const tooDeep = manualDepth(tree, nodeId) >= MAX_DEPTH

  /**
   * Fill in a checklist row.
   *
   * The row's key rides into the record as `prelaunchKey`, which is the only
   * thing that will ever connect the certificate to the row it satisfies —
   * matching on the title would break the first time somebody edited it.
   */
  const fillRow = (item) => setDocDialog({
    mode: 'new',
    seed: {
      title: item.title,
      docType: item.docType || '',
      owner: item.owner || '',
      prelaunchKey: item.key,
    },
  })

  const fileMenu = (doc) => (
    <TileMenu
      label={`Actions for ${doc.title || 'this document'}`}
      items={[
        { label: 'Details', icon: Eye, onClick: () => setDetails(doc) },
        canWrite && {
          label: 'Edit',
          icon: Pencil,
          onClick: () => setDocDialog({ mode: 'edit', doc: { ...doc, __node: resolveNode(doc, tree) } }),
        },
        can(role, 'record.delete') && {
          label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteDoc(doc),
        },
      ]}
    />
  )

  const folderMenu = (child) => (child.kind === 'manual' ? (
    <TileMenu
      label={`Actions for ${child.name}`}
      items={[
        canWrite && {
          label: 'Rename', icon: Pencil,
          onClick: () => setFolderDialog({ mode: 'rename', folder: child }),
        },
        // Deleting is manager-only in firestore.rules; showing the item to
        // everyone would only produce a refusal.
        isManager && { label: 'Delete', icon: Trash2, danger: true, onClick: () => deleteFolder(child) },
      ]}
    />
  ) : null)

  return (
    <>
      <PageHeader
        title={module.title}
        subtitle="Policies, SOPs, forms and Safety Data Sheets, filed by region, entity and site"
        icon={module.icon}
        actions={
          (canFolderHere || canFileHere) && (
            <div className="flex flex-wrap gap-2">
              {canFolderHere && (
                <Button
                  variant="soft"
                  icon={FolderPlus}
                  disabled={tooDeep}
                  title={tooDeep ? `Folders stop at ${MAX_DEPTH} levels deep` : undefined}
                  onClick={() => setFolderDialog({ mode: 'new' })}
                >
                  New folder
                </Button>
              )}
              {canFileHere && (
                <Button icon={Upload} onClick={() => setDocDialog({ mode: 'new' })}>
                  Add document
                </Button>
              )}
            </div>
          )
        }
      />

      {/* Breadcrumb + search. The breadcrumb is the only navigation control —
          there is no "up" button, because every ancestor is already one click
          away and a browser with two ways up has two things to keep in step. */}
      <div className="card mb-4 flex flex-wrap items-center gap-2 px-3 py-2">
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => go('')}
            className={`rounded-lg px-2 py-1 text-sm font-semibold transition hover:bg-surface-100 ${
              atTop ? 'text-ink-900' : 'text-brand-600'
            }`}
          >
            Documents
          </button>
          {trail.map((c, i) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={14} className="flex-none text-ink-300" />
              <button
                type="button"
                onClick={() => go(c.id)}
                aria-current={i === trail.length - 1 ? 'page' : undefined}
                className={`min-w-0 truncate rounded-lg px-2 py-1 text-sm transition hover:bg-surface-100 ${
                  i === trail.length - 1 ? 'font-bold text-ink-900' : 'font-semibold text-brand-600'
                }`}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="relative w-full sm:w-64">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input
            className="!py-2 pl-9"
            placeholder="Search every folder…"
            aria-label="Search documents"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {docs === null ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : results ? (
        // Search deliberately ignores the folder you are standing in: somebody
        // who cannot find a document does not know which folder to stand in.
        <section>
          <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-400">
            {results.length} result{results.length === 1 ? '' : 's'} across every folder
          </h2>
          {results.length === 0 ? (
            <EmptyState icon={Search} title="Nothing matches" description={`No document mentions “${search.trim()}”.`} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((doc) => (
                <div key={doc.id}>
                  <FileTile doc={doc} onOpen={() => openDoc(doc)} menu={fileMenu(doc)} />
                  <button
                    type="button"
                    onClick={() => go(resolveNode(doc, tree))}
                    className="mt-1 block w-full truncate px-3 text-left text-xs font-semibold text-ink-400 hover:text-brand-600"
                  >
                    in {pathOf(doc)}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : childIds.length === 0 && here.length === 0 && !category ? (
        <EmptyState
          icon={FolderIcon}
          title="This folder is empty"
          description={
            node?.filable
              ? 'Add a document, or make a subfolder to organise what goes in here.'
              : 'These documents name no region. Edit one to file it where it belongs.'
          }
          action={canFileHere && (
            <Button icon={Plus} onClick={() => setDocDialog({ mode: 'new' })}>Add document</Button>
          )}
        />
      ) : (
        <div className="space-y-5">
          {/* The handover pack, over the folder it is filed in. A Pre Launch
              folder is the one place in the library where what is MISSING is
              the answer, so it is said before anything that is there. */}
          {isPreLaunch && readiness && (
            <ReadinessPanel
              title={`${node.name} — ${trail[trail.length - 2]?.name || 'this site'}`}
              subtitle={`The handover schedule asks this site for ${PRE_LAUNCH_TOTAL} documents, in the ${readiness.byCategory.length} categories below.`}
              readiness={readiness}
            />
          )}
          {category && (
            <ReadinessPanel
              title={category.name}
              subtitle={`${category.total} document${category.total === 1 ? '' : 's'} the handover schedule asks for under ${category.numeral}. ${category.name}.`}
              readiness={category}
            />
          )}

          {/* Every row of the checklist, filled or not. The empty ones are the
              point: a folder can only show what somebody uploaded, and the
              question at a handover is what nobody did. */}
          {category && (
            <section>
              <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-400">
                Required documents{' '}
                <span className="text-ink-300">({category.ready} of {category.total} ready)</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {category.rows.map((row) => (
                  <ChecklistTile
                    key={row.item.key}
                    row={row}
                    canWrite={canWrite}
                    onOpen={() => row.doc && openDoc(row.doc)}
                    onFill={() => fillRow(row.item)}
                    menu={row.doc ? fileMenu(row.doc) : null}
                  />
                ))}
              </div>
            </section>
          )}

          {childIds.length > 0 && (
            <section>
              <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-400">Folders</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {childIds.map((id) => {
                  const child = nodeAt(tree, id)
                  if (!child) return null
                  return (
                    <FolderTile
                      key={id}
                      node={child}
                      count={total.get(id) || 0}
                      readiness={readinessFor(child)}
                      onOpen={() => go(id)}
                      menu={folderMenu(child)}
                    />
                  )
                })}
              </div>
            </section>
          )}

          {loose.length > 0 && (
            <section>
              <h2 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-400">
                {/* Named differently inside a category, where the checklist
                    above already showed the documents that belong to a row. */}
                {category ? 'Other documents here' : 'Documents'}{' '}
                <span className="text-ink-300">({loose.length} here)</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {loose.map((doc) => (
                  <FileTile key={doc.id} doc={doc} onOpen={() => openDoc(doc)} menu={fileMenu(doc)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {docDialog && (
        <DocumentDialog
          // The dialog seeds its form state once, so a different document — or
          // a different checklist row — has to be a different component
          // instance.
          key={docDialog.doc?.id || docDialog.seed?.prelaunchKey || 'new'}
          open
          mode={docDialog.mode}
          doc={docDialog.doc}
          seed={docDialog.seed}
          nodeId={nodeId}
          tree={tree}
          sites={sites}
         
          busy={busy}
          onClose={() => setDocDialog(null)}
          onSubmit={saveDoc}
        />
      )}

      {folderDialog && (
        <FolderDialog
          open
          mode={folderDialog.mode}
          initial={folderDialog.folder?.name}
          siblings={siblingsOf(tree, folderDialog.folder?.parentId ?? nodeId)}
          exceptId={folderDialog.folder?.id}
          busy={busy}
          onClose={() => setFolderDialog(null)}
          onSubmit={saveFolder}
        />
      )}

      {details && (
        <DetailsDialog doc={details} path={pathOf(details)} onClose={() => setDetails(null)} />
      )}
    </>
  )
}
