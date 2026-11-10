import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import {
  Trash2,
  RotateCcw,
  AlertTriangle,
  Database,
  Flame,
  HeartPulse,
  BellRing,
  Search,
  X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Spinner, Badge } from '../components/ui'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useFleet } from '../context/FleetContext'
import { useAuth } from '../context/AuthContext'
import {
  restoreExtinguishers,
  purgeExtinguisher,
  restoreAeds,
  purgeAed,
  restoreFasMany,
  purgeFas,
} from '../lib/data'
import { downloadJsonBackup } from '../lib/exporter'
import { toDate } from '../lib/extinguisherLogic'
import { canManageAsset, daysRemaining, matchesBinSearch, PURGE_AFTER_DAYS } from '../lib/recycle'

const KINDS = {
  extinguisher: {
    label: 'Extinguisher',
    icon: Flame,
    code: (r) => r.serialNo || '—',
    detail: (r) => [r.type, r.capacity].filter(Boolean).join(' · '),
    restore: restoreExtinguishers,
    purge: (row, actor) =>
      purgeExtinguisher(row.id, row.qrToken, actor, row.serialNo || row.type),
  },
  aed: {
    label: 'AED',
    icon: HeartPulse,
    code: (r) => r.assetId || '—',
    detail: (r) => [r.brand, r.model].filter(Boolean).join(' · '),
    restore: restoreAeds,
    purge: (row, actor) => purgeAed(row.id, row.qrToken, actor, row.assetId),
  },
  fas: {
    label: 'Fire alarm',
    icon: BellRing,
    code: (r) => r.deviceId || r.deviceType || '—',
    detail: (r) => (r.deviceType && r.deviceId ? r.deviceType : ''),
    restore: restoreFasMany,
    purge: (row, actor) =>
      purgeFas(row.id, row.qrToken, actor, row.deviceId || row.deviceType),
  },
}

const keyOf = (row) => `${row.kind}:${row.id}`

export default function RecycleBin() {
  const { deletedExtinguishers, deletedAeds, deletedFas, extinguishers, reports, users, org } =
    useFleet()
  const { orgName, profile, isAdmin, isManager } = useAuth()
  const actor = { uid: profile?.uid, name: profile?.name }
  const [selected, setSelected] = useState(new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [purgeFor, setPurgeFor] = useState(null)

  const fmt = (v) => {
    const d = toDate(v)
    return d ? format(d, 'dd MMM yyyy, HH:mm') : '—'
  }

  const rows = useMemo(() => {
    const tagged = [
      ...deletedExtinguishers.map((r) => ({ ...r, kind: 'extinguisher' })),
      ...(deletedAeds || []).map((r) => ({ ...r, kind: 'aed' })),
      ...(deletedFas || []).map((r) => ({ ...r, kind: 'fas' })),
    ]
    return tagged
      .filter((r) => canManageAsset(profile, r, { isAdmin, isManager }))
      .sort((a, b) => (toDate(b.deletedAt) || 0) - (toDate(a.deletedAt) || 0))
  }, [deletedExtinguishers, deletedAeds, deletedFas, profile, isAdmin, isManager])

  // Filter after the deletedAt sort, so a search narrows the list the page
  // already shows and does not reshuffle it. The slice is the in-memory bin
  // (the same read cap as the live registers); a query cannot see a row the
  // load already dropped.
  const visible = useMemo(() => rows.filter((row) => matchesBinSearch(row, query)), [rows, query])
  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(visible)
  const visibleKeys = useMemo(() => new Set(visible.map(keyOf)), [visible])
  const shownSelected = [...selected].filter((key) => visibleKeys.has(key))
  const hiddenSelected = selected.size - shownSelected.length

  const setQueryAndReset = (value) => {
    setQuery(value)
    // A keystroke that leaves you on page 7 of a two-page result reads as
    // "nothing matched". Start each query on the first page.
    setPage(1)
  }

  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  const pageKeys = pageItems.map(keyOf)
  const allOnPage = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k))
  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOnPage) pageKeys.forEach((k) => next.delete(k))
      else pageKeys.forEach((k) => next.add(k))
      return next
    })

  const restoreKeys = async (keys) => {
    // Only rows the current search still shows. A tick made before typing
    // stays ticked, but it is not in `visible`, so Restore cannot bring back
    // a unit the person can no longer see on this page.
    const chosen = visible.filter((r) => keys.has(keyOf(r)))
    if (!chosen.length) return
    setBusy(true)
    try {
      for (const kind of Object.keys(KINDS)) {
        const ids = chosen.filter((r) => r.kind === kind).map((r) => r.id)
        if (ids.length) await KINDS[kind].restore(org?.name || orgName, ids, actor)
      }
      toast.success(chosen.length === 1 ? 'Restored' : `Restored ${chosen.length}`)
      setSelected((prev) => {
        const next = new Set(prev)
        chosen.forEach((r) => next.delete(keyOf(r)))
        return next
      })
    } catch (e) {
      toastCaught(e, 'Could not restore')
    } finally {
      setBusy(false)
    }
  }

  const confirmPurge = async () => {
    if (!purgeFor) return
    setBusy(true)
    try {
      await KINDS[purgeFor.kind].purge(purgeFor, actor)
      toast.success('Permanently deleted')
      setPurgeFor(null)
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(keyOf(purgeFor))
        return next
      })
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  const downloadBackup = () => {
    const snapshot = {
      exportedAt: new Date().toISOString(),
      org: org || null,
      extinguishers: [...extinguishers, ...deletedExtinguishers],
      reports,
      users,
    }
    downloadJsonBackup(
      snapshot,
      `fire-marshal-backup-${new Date().toISOString().slice(0, 10)}.json`
    )
    toast.success('Backup downloaded')
  }

  return (
    <div>
      <PageHeader
        title="Recently deleted"
        subtitle={`Hidden from lists, counts and QR inspections. Restore within ${PURGE_AFTER_DAYS} days and the same QR sticker works again. After that they are removed automatically.`}
        icon={Trash2}
      >
        {isAdmin && (
          <button
            className="btn-ghost"
            onClick={downloadBackup}
            title="Download a full JSON backup"
          >
            <Database size={16} /> Download backup
          </button>
        )}
      </PageHeader>

      {rows.length > 0 && (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400">
              <Search size={13} /> Search
            </span>
            <div className="relative min-w-[200px] flex-1">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
              />
              <input
                className="input pl-9"
                placeholder="Search serial, asset ID, QR, site or who deleted…"
                aria-label="Search recently deleted"
                value={query}
                onChange={(e) => setQueryAndReset(e.target.value)}
              />
            </div>
            {query.trim() && (
              <button
                type="button"
                className="btn-ghost"
                aria-label="Clear search"
                onClick={() => setQueryAndReset('')}
              >
                <X size={15} /> Clear
              </button>
            )}
          </div>
          <p className="text-sm text-ink-500" aria-live="polite">
            {query.trim()
              ? `${visible.length} of ${rows.length} match`
              : `${rows.length} recently deleted`}
          </p>
        </div>
      )}

      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-canvas px-4 py-3 text-ink-900">
          <span className="font-bold">{selected.size} selected</span>
          {hiddenSelected > 0 && (
            <span>
              {hiddenSelected === 1
                ? '1 selected is hidden by this search and will not be restored.'
                : `${hiddenSelected} selected are hidden by this search and will not be restored.`}
            </span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              className="btn bg-green-600 text-white hover:brightness-110"
              disabled={busy || shownSelected.length === 0}
              onClick={() => restoreKeys(new Set(shownSelected))}
            >
              {busy ? (
                <Spinner size={16} />
              ) : (
                <>
                  <RotateCcw size={15} />{' '}
                  {hiddenSelected > 0 && shownSelected.length > 0
                    ? `Restore ${shownSelected.length} shown`
                    : 'Restore selected'}
                </>
              )}
            </button>
            <button
              className="btn bg-white/10 text-white hover:bg-white/20"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title="Nothing was recently deleted"
          hint="Deleted extinguishers, AEDs and fire-alarm panels can be restored from here before they are removed."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title={`No deleted units match “${query.trim()}”`}
          hint="Try a serial number, asset ID, QR code, site, or the name of the person who deleted it."
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-brand-500"
                      checked={allOnPage}
                      onChange={togglePage}
                      aria-label="Select all on this page"
                    />
                  </th>
                  <th className="px-4 py-3">Unit</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Deleted by</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3">Days left</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200/60">
                {pageItems.map((row) => {
                  const kind = KINDS[row.kind]
                  const left = daysRemaining(row.deletedAt)
                  const key = keyOf(row)
                  const Icon = kind.icon
                  return (
                    <tr
                      key={key}
                      className="hover:bg-surface-100/50"
                      style={{ boxShadow: 'inset 4px 0 0 #dc2626' }}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-brand-500"
                          checked={selected.has(key)}
                          onChange={() => toggle(key)}
                          aria-label={`Select ${kind.label} ${kind.code(row)}`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 font-bold text-ink-900">
                          <Icon size={14} className="text-ink-400" aria-hidden="true" />
                          {kind.code(row)}
                        </div>
                        <div className="text-xs text-ink-500">
                          {kind.label}
                          {kind.detail(row) ? ` · ${kind.detail(row)}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-ink-700">{row.centerName || '—'}</td>
                      <td className="px-4 py-3 text-ink-700">{row.deletedBy || '—'}</td>
                      <td className="px-4 py-3 text-ink-600">{fmt(row.deletedAt)}</td>
                      <td className="px-4 py-3">
                        <Badge color={left <= 5 ? '#dc2626' : '#f59e0b'}>{left}d left</Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            className="btn bg-green-600 px-2.5 py-1.5 text-xs text-white hover:brightness-110"
                            disabled={busy}
                            onClick={() => restoreKeys(new Set([key]))}
                            aria-label={`Restore ${kind.label} ${kind.code(row)}`}
                          >
                            <RotateCcw size={14} /> Restore
                          </button>
                          {isAdmin && (
                            <button
                              className="btn-danger px-2.5 py-1.5 text-xs"
                              onClick={() => setPurgeFor(row)}
                              aria-label={`Permanently delete ${kind.label} ${kind.code(row)}`}
                            >
                              <Trash2 size={14} /> Delete permanently
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-surface-200/60 px-4 py-3"
            page={page}
            pageCount={pageCount}
            onPage={setPage}
            total={total}
            pageSize={pageSize}
          />
        </div>
      )}

      <Modal open={!!purgeFor} onClose={() => setPurgeFor(null)} title="Delete permanently?">
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
          <AlertTriangle size={16} />
          <span>
            This permanently deletes{' '}
            <strong>{purgeFor ? KINDS[purgeFor.kind].code(purgeFor) : ''}</strong> and its QR code.
            Printed stickers for it will stop working. This cannot be undone.
          </span>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setPurgeFor(null)}>
            Cancel
          </button>
          <button className="btn-danger" onClick={confirmPurge} disabled={busy}>
            {busy ? (
              <Spinner size={18} />
            ) : (
              <>
                <Trash2 size={16} /> Delete permanently
              </>
            )}
          </button>
        </div>
      </Modal>
    </div>
  )
}
