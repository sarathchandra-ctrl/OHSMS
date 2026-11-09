import { useRef, useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle, X, Loader2, RefreshCw, PlusCircle, MapPin } from 'lucide-react'
import toast from 'react-hot-toast'
import { PageHeader, Spinner } from '../components/ui'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { downloadTemplate, parseUpload } from '../lib/exporter'
import { bulkUpsertExtinguishers } from '../lib/firestore'
import { linkImportRows } from '../lib/siteLink'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { assignSerials } from '../lib/serial'
import { holdRetiredImports } from '../lib/recycle'
import { BULK_COLUMNS } from '../lib/constants'
import { toastCaught } from '../../../shared/lib/toastCaught'

export default function BulkUpload() {
  const { orgName, profile } = useAuth()
  const { extinguishers, deletedExtinguishers } = useFleet()
  const orgSites = useAccessibleSites()
  const inputRef = useRef(null)
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState(null) // { valid, errors, total }
  const [committing, setCommitting] = useState(false)
  const [done, setDone] = useState(null) // { created, updated }

  // Map of existing serial (lowercased) → existing extinguisher, for matching.
  const bySerial = useMemo(() => {
    const m = new Map()
    for (const e of extinguishers) {
      const s = (e.serialNo || '').trim().toLowerCase()
      if (s) m.set(s, e)
    }
    return m
  }, [extinguishers])

  // Split parsed rows into creates (new) + updates (matched existing serial),
  // assigning auto-serials to blank-serial creates.
  //
  // Rows are resolved against the site registry FIRST, so an import arrives
  // already linked. Without that step this page wrote centerName as free text
  // and no siteId, and every unit it created needed the linking pass afterwards
  // — the same omission addExtinguisher had, and the AED/FAS uploader avoids.
  //
  // Rows whose centre does not resolve never reach `creates`/`updates`, so
  // there is no path from here that writes an unlinked record.
  const plan = useMemo(() => {
    if (!result?.valid) return null
    const { rows: linkedRows, blocked, unmatched } = linkImportRows(result.valid, orgSites)
    const updates = []
    const newRows = []

    for (const row of linkedRows) {
      const s = (row.serialNo || '').trim().toLowerCase()
      const match = s ? bySerial.get(s) : null
      if (match) {
        updates.push({
          ...row,
          id: match.id,
          qrToken: match.qrToken,
          status: match.status,
          physicalDefects: match.physicalDefects || [],
        })
      } else {
        newRows.push(row)
      }
    }
    // A serial sitting in Recently deleted is not an overwrite of a live row,
    // and it is not free either. Holding it here, before serials are assigned,
    // keeps an auto-number from being spent on a row that will not be written.
    const retired = deletedExtinguishers || []
    const { fresh, held } = holdRetiredImports(newRows, {
      live: extinguishers,
      deleted: retired,
      codeField: 'serialNo',
    })
    const existingSerials = [...extinguishers, ...retired].map((e) => e.serialNo).filter(Boolean)
    const creates = assignSerials(fresh, existingSerials)
    return { creates, updates, blocked, unmatched, held }
  }, [result, bySerial, extinguishers, deletedExtinguishers, orgSites])

  const handleFile = async (file) => {
    if (!file) return
    setFileName(file.name)
    setParsing(true)
    setResult(null)
    try {
      const r = await parseUpload(file)
      setResult(r)
      if (r.valid.length === 0) toast.error('No valid rows found')
      else toast.success(`${r.valid.length} valid row(s) ready`)
    } catch (e) {
      // Say what was actually wrong. The size and row-count guards produce an
      // actionable sentence; discarding it for a generic one leaves someone
      // re-uploading the same oversized file.
      toastCaught(e, 'Could not read that file')
    } finally {
      setParsing(false)
    }
  }

  const commit = async () => {
    if (!plan || (!plan.creates.length && !plan.updates.length)) return
    setCommitting(true)
    try {
      const res = await bulkUpsertExtinguishers(orgName, plan, { uid: profile?.uid, name: profile?.name })
      // Carry the held-back count into the summary: `plan` is cleared below, and
      // "42 added" on a 50-row file should not be the only thing the person sees.
      setDone({ ...res, heldBack: plan.blocked.length, retiredHeld: plan.held.length })
      toast.success(`${res.created} added, ${res.updated} updated`)
      setResult(null)
      setFileName('')
    } catch (e) {
      toastCaught(e, 'Could not import', { action: 'import these extinguishers' })
    } finally {
      setCommitting(false)
    }
  }

  const reset = () => {
    setResult(null)
    setFileName('')
    setDone(null)
  }

  // Combined preview rows tagged with their action.
  const previewRows = useMemo(() => {
    if (!plan) return []
    return [
      ...plan.updates.map((r) => ({ ...r, __action: 'overwrite' })),
      ...plan.creates.map((r) => ({ ...r, __action: 'new' })),
    ]
  }, [plan])

  // Preview and error list page separately — only what is rendered is paged.
  // `commit` still writes the whole `plan`, not the visible page.
  const previewPage = usePagination(previewRows)
  const errorsPage = usePagination(result?.errors || [])

  return (
    <div>
      <PageHeader
        title="Bulk Upload"
        subtitle="Import or update many extinguishers from a spreadsheet. Matching Serial No overwrites the existing record."
        icon={Upload}
      >
        <button className="btn-ghost" onClick={downloadTemplate}>
          <Download size={16} /> Download template
        </button>
      </PageHeader>

      {done ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          className="card mx-auto max-w-lg p-8 text-center"
        >
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-green-100 text-green-600">
            <CheckCircle2 size={34} />
          </div>
          <h2 className="text-xl font-extrabold">Import complete</h2>
          <p className="mt-1 text-sm text-ink-500">
            <strong>{done.created}</strong> added · <strong>{done.updated}</strong> updated. New records
            have unique QR codes; updated records keep their existing QR.
          </p>
          {done.heldBack > 0 && (
            <p className="mt-2 text-sm font-medium text-amber-700">
              {done.heldBack} row(s) were held back — their site is not in the registry.
            </p>
          )}
          {done.retiredHeld > 0 && (
            <p className="mt-2 text-sm font-medium text-amber-700">
              {done.retiredHeld} row(s) were held back — the serial or QR code belongs to a unit
              that is still on record, including Recently deleted. Restore that unit instead of
              adding it again.
            </p>
          )}
          <div className="mt-6 flex justify-center gap-3">
            <button className="btn-primary" onClick={reset}>Import more</button>
            <a className="btn-ghost" href="/equipment/repository">View repository</a>
          </div>
        </motion.div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Drop zone */}
          <div className="lg:col-span-2 space-y-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                handleFile(e.dataTransfer.files?.[0])
              }}
              className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl bg-surface-50 px-6 py-14 text-center ring-1 ring-ink-200 transition hover:bg-brand-50/40"
            >
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-500">
                {parsing ? <Loader2 className="animate-spin" /> : <FileSpreadsheet size={26} />}
              </div>
              <p className="font-bold text-ink-800">
                {fileName || 'Click to upload or drag & drop'}
              </p>
              <p className="text-sm text-ink-500">.xlsx or .csv using the template columns</p>
            </button>
            {/* Outside the button: a <button> may not contain a form control,
                and the picker is opened through the ref either way. */}
            <input
              ref={inputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />

            {result && plan && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="chip bg-green-100 text-green-700">
                    <PlusCircle size={14} /> {plan.creates.length} new
                  </span>
                  <span className="chip bg-indigo-100 text-indigo-700">
                    <RefreshCw size={14} /> {plan.updates.length} overwrite
                  </span>
                  {result.errors.length > 0 && (
                    <span className="chip bg-red-100 text-red-700">
                      <AlertTriangle size={14} /> {result.errors.length} with issues
                    </span>
                  )}
                  {plan.blocked.length > 0 && (
                    <span className="chip bg-amber-100 text-amber-700">
                      <MapPin size={14} /> {plan.blocked.length} held back
                    </span>
                  )}
                  {plan.held.length > 0 && (
                    <span className="chip bg-amber-100 text-amber-700">
                      <AlertTriangle size={14} /> {plan.held.length} already on record
                    </span>
                  )}
                  <span className="text-sm text-ink-500">{result.total} total rows</span>
                </div>

                {/* Named and counted, not just counted: "3 held back" tells
                    nobody which spelling to correct. */}
                {plan.unmatched.length > 0 && (
                  <div className="card border border-amber-200 bg-amber-50/40 p-4">
                    <p className="text-sm font-bold text-amber-800">
                      {plan.blocked.length} row(s) will not be imported — site not in the registry
                    </p>
                    <p className="mt-1 text-xs text-amber-700">
                      A record with no site cannot be traced back to a location, so these are held
                      back rather than imported unlinked. Correct the spelling in the file, or add
                      the site to the registry first, then upload again.
                    </p>
                    <ul className="mt-3 space-y-1.5">
                      {plan.unmatched.map((u) => (
                        <li key={u.given} className="text-sm text-ink-700">
                          <span className="font-semibold">{u.given}</span>
                          <span className="text-ink-400"> · {u.count} row(s)</span>
                          {u.suggestion && (
                            <span className="text-ink-500"> — did you mean “{u.suggestion.name}”?</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.held.length > 0 && (
                  <div className="card border border-amber-200 bg-amber-50/40 p-4">
                    <p className="text-sm font-bold text-amber-800">
                      {plan.held.length} row(s) will not be imported — serial or QR already on record
                    </p>
                    <p className="mt-1 text-xs text-amber-700">
                      A unit in Recently deleted can be restored with the same QR sticker. Adding
                      it again would put that code on two cylinders.
                    </p>
                    <ul className="mt-3 space-y-1.5">
                      {plan.held.map((h, i) => (
                        <li key={`${h.row.serialNo || 'row'}-${i}`} className="text-sm text-ink-700">
                          <span className="font-semibold">{h.row.serialNo || 'No serial'}</span>
                          <span className="text-ink-500"> — {h.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {previewRows.length > 0 && (
                  <div className="card overflow-hidden">
                    <div className="border-b border-ink-100 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-ink-500">
                      Preview ({previewRows.length})
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-100/70 text-left text-xs uppercase text-ink-400">
                          <tr>
                            <th className="px-3 py-2">Action</th>
                            <th className="px-3 py-2">Serial</th>
                            <th className="px-3 py-2">Type</th>
                            <th className="px-3 py-2">Capacity</th>
                            <th className="px-3 py-2">Entity</th>
                            <th className="px-3 py-2">Region</th>
                            <th className="px-3 py-2">Center</th>
                            <th className="px-3 py-2">Next Refill</th>
                            <th className="px-3 py-2">Next HPT</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {previewPage.pageItems.map((r, i) => (
                            <tr key={i}>
                              <td className="px-3 py-2">
                                {r.__action === 'overwrite' ? (
                                  <span className="chip bg-indigo-100 text-indigo-700">Overwrite</span>
                                ) : (
                                  <span className="chip bg-green-100 text-green-700">New</span>
                                )}
                              </td>
                              <td className="px-3 py-2 font-semibold">{r.serialNo || '—'}</td>
                              <td className="px-3 py-2">{r.type}</td>
                              <td className="px-3 py-2">{r.capacity}</td>
                              <td className="px-3 py-2">{r.entity}</td>
                              <td className="px-3 py-2">{r.region || '—'}</td>
                              <td className="px-3 py-2">{r.centerName}</td>
                              <td className="px-3 py-2">{r.dateOfNextRefill || '—'}</td>
                              <td className="px-3 py-2">{r.dateOfNextHPT || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pager
                      className="border-t border-ink-100 px-3 py-2"
                      page={previewPage.page}
                      pageCount={previewPage.pageCount}
                      onPage={previewPage.setPage}
                      total={previewPage.total}
                      pageSize={previewPage.pageSize}
                    />
                  </div>
                )}

                {result.errors.length > 0 && (
                  <div className="card overflow-hidden border border-red-200">
                    <div className="border-b border-red-100 bg-red-50 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-red-600">
                      Rows skipped
                    </div>
                    <ul className="divide-y divide-ink-100 text-sm">
                      {errorsPage.pageItems.map((e, i) => (
                        <li key={i} className="flex items-start gap-2 px-4 py-2.5">
                          <X size={15} className="mt-0.5 shrink-0 text-red-500" />
                          <span>
                            <strong>Row {e.row}:</strong> {e.issues.join('; ')}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <Pager
                      className="border-t border-ink-100 px-3 py-2"
                      page={errorsPage.page}
                      pageCount={errorsPage.pageCount}
                      onPage={errorsPage.setPage}
                      total={errorsPage.total}
                      pageSize={errorsPage.pageSize}
                    />
                  </div>
                )}

                {(plan.creates.length > 0 || plan.updates.length > 0) && (
                  <div className="flex justify-end gap-3">
                    <button className="btn-ghost" onClick={reset}>Cancel</button>
                    <button className="btn-primary" onClick={commit} disabled={committing}>
                      {committing ? <Spinner size={18} /> : `Import ${plan.creates.length + plan.updates.length} extinguishers`}
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </div>

          {/* Instructions */}
          <aside className="card h-fit space-y-3 p-6">
            <h3 className="text-sm font-bold uppercase tracking-wide text-ink-500">How it works</h3>
            <ol className="space-y-2 text-sm text-ink-600">
              <li>1. Download the template.</li>
              <li>2. Fill one extinguisher per row. Serial No is optional.</li>
              <li>3. Upload — we validate against the allowed values.</li>
              <li>4. Review: rows matching an existing Serial No are <strong>overwritten</strong>; the rest are added.</li>
            </ol>
            <div className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 text-xs text-ink-600 ">
              <p className="mb-1 font-bold uppercase text-ink-500">Serial No</p>
              Leave it blank to auto-assign a unique <code>FE-####</code>. A matching serial overwrites that
              record’s details but keeps its QR code, status and defects. A serial or QR code that is
              in Recently deleted is held back — restore that extinguisher instead.
            </div>
            <div className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 ">
              <p className="mb-1 text-xs font-bold uppercase text-ink-500">Columns</p>
              <div className="flex flex-wrap gap-1.5">
                {BULK_COLUMNS.map((c) => (
                  <span key={c} className="chip bg-surface text-ink-600">{c}</span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
