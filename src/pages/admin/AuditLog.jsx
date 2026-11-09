import { useEffect, useMemo, useState } from 'react'
import { ScrollText, Search, Download } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import toast from 'react-hot-toast'
import { subscribeAuditLogs, fetchAuditLogs, logAudit } from '../../shared/org/orgData'
import { auditRows, auditExportSummary } from '../../shared/audit/auditExport'
import { toastCaught } from '../../shared/lib/toastCaught'
import { isPermissionDenied } from '../../shared/lib/permissionDenied'
import { auditLabel, AUDIT } from '../../shared/audit/audit'
import { MODULE_BY_KEY } from '../../shared/modules/registry'
import { PageHeader, Badge, Input, SkeletonTable, EmptyState } from '../../shared/ui'
import { formatDateTime } from '../../shared/lib/format'

// What the live view holds, and the ceiling on a ranged query. The second is
// far higher because a range is a question asked once, not a listener kept open.
const LIVE_LIMIT = 400
const RANGE_LIMIT = 5000

export default function AuditLog() {
  const { orgName, actor } = useAuth()
  const [logs, setLogs] = useState(null)
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)

  const ranged = Boolean(from || to)
  const capped = ranged && (logs?.length ?? 0) >= RANGE_LIMIT

  useEffect(() => {
    // With no range this stays live, which is what the page is for day to day.
    // With one it becomes a one-shot read: collecting evidence is a question
    // asked once, and a subscription over a wide range would stream the whole
    // period into memory and keep it there.
    if (!ranged) return subscribeAuditLogs(setLogs, LIVE_LIMIT)

    let alive = true
    setLogs(null)
    fetchAuditLogs({ from, to, max: RANGE_LIMIT })
      .then((rows) => alive && setLogs(rows))
      .catch((e) => {
        if (!alive) return
        if (isPermissionDenied(e)) {
          setLogs([])
          return
        }
        toastCaught(e, 'Could not load the audit log', { action: 'load the audit log' })
        setLogs([])
      })
    return () => { alive = false }
  }, [ranged, from, to])

  /**
   * Hand the trail over as a file.
   *
   * An append-only log that can only be scrolled in a browser satisfies neither
   * half of "collect evidence": the reader cannot keep it and cannot attach it
   * to anything. Exports what is ON SCREEN, filters included, so the file and
   * the page cannot disagree.
   */
  const doExport = async () => {
    const rows = auditRows(filtered)
    if (!rows.length) return toast.error('Nothing to export')
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const { jsonToSheet, aoaToSheet } = await import('../../shared/lib/sheet')
      const wb = XLSX.utils.book_new()
      const summary = aoaToSheet(
        auditExportSummary({ orgName, from, to, count: rows.length, capped }),
      )
      summary['!cols'] = [{ wch: 26 }, { wch: 60 }]
      XLSX.utils.book_append_sheet(wb, summary, 'About this export')
      const sheet = jsonToSheet(rows)
      sheet['!cols'] = [{ wch: 24 }, { wch: 28 }, { wch: 22 }, { wch: 16 }, { wch: 22 }, { wch: 24 }, { wch: 28 }, { wch: 22 }, { wch: 60 }, { wch: 22 }]
      XLSX.utils.book_append_sheet(wb, sheet, 'Audit trail')
      XLSX.writeFile(wb, `audit-log-${from || 'start'}-to-${to || 'now'}.xlsx`)
      // Recorded in the trail it is a copy of. Taking the audit log is the one
      // export where an unrecorded copy matters most — it is the evidence
      // itself leaving the system, and the next entry after this one is the
      // proof of who took it.
      logAudit(actor, AUDIT.EXPORT, {
        module: 'core',
        targetLabel: `${rows.length} audit entries`,
        summary: `Exported the audit log (${from || 'earliest'} to ${to || 'latest'})${capped ? ', truncated at the query limit' : ''}`,
      })
      toast.success(`Exported ${rows.length} entries`)
    } catch (e) {
      toastCaught(e, 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const filtered = useMemo(() => {
    if (!logs) return []
    const q = search.trim().toLowerCase()
    if (!q) return logs
    return logs.filter((l) => JSON.stringify(l).toLowerCase().includes(q))
  }, [logs, search])

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Append-only record of every action across all modules"
        icon={ScrollText}
        actions={
          <button type="button" className="btn-ghost" onClick={doExport} disabled={busy}>
            <Download size={16} /> Export
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="relative max-w-xs flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input className="!py-2 pl-9" placeholder="Search activity…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {/* The trail was the newest 400 with no way to ask for a period, so
            "what happened to this permit in March" stopped being answerable the
            moment 400 events had accrued — days, in a busy tenant. */}
        <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-500">
          From
          <Input type="date" className="!py-2 font-mono" value={from} max={to || undefined}
            onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-500">
          To
          <Input type="date" className="!py-2 font-mono" value={to} min={from || undefined}
            onChange={(e) => setTo(e.target.value)} />
        </label>
        {(from || to) && (
          <button type="button" className="btn-ghost text-xs" onClick={() => { setFrom(''); setTo('') }}>
            Clear
          </button>
        )}
      </div>

      {/* Says what is on screen. A range that returned everything and a range
          that hit its ceiling look identical otherwise, and only one of them is
          a complete answer. */}
      <p className="mb-3 text-xs text-ink-500">
        {ranged
          ? `${logs?.length ?? 0} entries${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`
          : `Showing the ${LIVE_LIMIT} most recent entries — set a date range to look further back`}
        {capped && <span className="font-semibold text-amber-700"> · limit reached, narrow the range</span>}
      </p>

      {logs === null ? (
        <SkeletonTable rows={8} cols={4} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={ScrollText} title="No activity" description="Actions across the platform will appear here." />
      ) : (
        <div className="card table-crisp overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-3 font-semibold">When</th>
                <th className="px-5 py-3 font-semibold">Who</th>
                <th className="px-5 py-3 font-semibold">Module</th>
                <th className="px-5 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} className="hover:bg-surface-100">
                  <td className="whitespace-nowrap px-5 py-3 text-ink-500">{formatDateTime(l.at)}</td>
                  <td className="px-5 py-3 font-medium text-ink-800">{l.actorName}</td>
                  <td className="px-5 py-3">
                    <Badge tone="gray">{MODULE_BY_KEY[l.module]?.label || l.module || 'Core'}</Badge>
                  </td>
                  <td className="px-5 py-3 text-ink-700">
                    {auditLabel(l.action)}
                    {l.targetLabel ? <span className="text-ink-500"> · {l.targetLabel}</span> : ''}
                    {l.summary && !l.targetLabel ? <span className="text-ink-500"> · {l.summary}</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
