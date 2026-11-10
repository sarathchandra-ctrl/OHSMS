import { useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle, X, Loader2, MapPin, Wand2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { PageHeader, Spinner } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { downloadAssetTemplate, parseAssetUpload, AED_BULK_COLUMNS, FAS_BULK_COLUMNS, STRETCHER_BULK_COLUMNS } from '../lib/exporter'
import { bulkAddAeds, bulkAddFas, bulkAddStretchers } from '../lib/data'
import { indexSites, resolveSite, suggestSite } from '../lib/siteLink'
import { useAccessibleSites } from '../../../shared/org/useAccessibleSites'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { toastCaught } from '../../../shared/lib/toastCaught'

const CFG = {
  aed: {
    label: 'AED', columns: AED_BULK_COLUMNS, add: bulkAddAeds, path: '/equipment/aed',
    cols: [['Asset ID', 'assetId'], ['Site', 'centerName'], ['Region', 'region'], ['Entity', 'entity'], ['Battery Exp', 'batteryExpiry'], ['Pad Exp', 'padExpiry'], ['Status', 'status']],
  },
  fas: {
    label: 'FAS', columns: FAS_BULK_COLUMNS, add: bulkAddFas, path: '/equipment/fas',
    cols: [['Device ID', 'deviceId'], ['Type', 'deviceType'], ['Site', 'centerName'], ['Region', 'region'], ['Next Service', 'nextService'], ['Status', 'status']],
  },
  stretcher: {
    label: 'Stretcher', columns: STRETCHER_BULK_COLUMNS, add: bulkAddStretchers, path: '/equipment/stretchers',
    cols: [['Asset ID', 'assetId'], ['Type', 'type'], ['Site', 'centerName'], ['Region', 'region'], ['Next Inspection', 'nextInspection'], ['Status', 'status']],
  },
}

export default function AssetBulkUpload() {
  const { orgName, profile } = useAuth()
  const location = useLocation()
  const inputRef = useRef(null)
  // Anything the caller does not name falls back to AED. A ternary on 'fas'
  // alone would have sent a "Bulk upload" pressed on the stretcher repository
  // to the AED tab, silently, with the AED template already downloaded.
  const [kind, setKind] = useState(() => (CFG[location.state?.kind] ? location.state.kind : 'aed'))
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState(null)
  const [committing, setCommitting] = useState(false)
  const [done, setDone] = useState(null)

  // Accepted "did you mean?" answers, keyed by row index.
  const [picked, setPicked] = useState({})
  const orgSites = useAccessibleSites()

  const cfg = CFG[kind]
  const reset = () => { setResult(null); setFileName(''); setDone(null); setPicked({}) }
  const switchKind = (k) => { setKind(k); reset() }

  /**
   * Check every parsed row's site against the registry.
   *
   * Three outcomes, and the middle one is the point: an exact or normalised
   * match is taken silently, a close-but-different name is offered as a
   * question rather than guessed at, and an unrecognised name blocks the row.
   * Importing a site that does not exist is what produced the equipment records
   * nothing could be matched to in the first place.
   *
   * With no registry loaded there is nothing to check against, so every row
   * passes — an org that has not set up sites can still upload.
   */
  const checked = useMemo(() => {
    if (!result?.valid.length) return []
    if (!orgSites.length) return result.valid.map((row, i) => ({ row, i, status: 'ok' }))
    const idx = indexSites(orgSites)
    return result.valid.map((row, i) => {
      const name = picked[i] || row.centerName
      const hit = resolveSite(name, orgSites, idx)
      if (hit) return { row, i, status: 'ok', site: hit.site }
      const near = suggestSite(name, orgSites, idx)
      return near
        ? { row, i, status: 'suggest', suggestion: near.site, given: name }
        : { row, i, status: 'missing', given: name }
    })
  }, [result, orgSites, picked])

  const ready = checked.filter((c) => c.status === 'ok')
  const suggested = checked.filter((c) => c.status === 'suggest')
  const missing = checked.filter((c) => c.status === 'missing')

  // A 900-row file is 900 rows of preview DOM. Each list pages on its own — one
  // shared page number would blank the other two. Only the rendering is paged:
  // `acceptAll` and `commit` below still run over the whole array.
  const readyPage = usePagination(ready)
  const suggestedPage = usePagination(suggested)
  const errorsPage = usePagination(result?.errors || [])

  const acceptAll = () => {
    setPicked((p) => {
      const next = { ...p }
      suggested.forEach((c) => { next[c.i] = c.suggestion.name })
      return next
    })
    toast.success(`${suggested.length} site name(s) corrected`)
  }

  const handleFile = async (file) => {
    if (!file) return
    setFileName(file.name); setParsing(true); setResult(null)
    try {
      const r = await parseAssetUpload(kind, file)
      setResult(r)
      if (!r.valid.length) toast.error('No valid rows found')
      else toast.success(`${r.valid.length} valid row(s) ready`)
      // The guard's message names the actual problem — the file's size against
      // the limit, or the row count — and "Could not read that file" threw all
      // of that away and left the person guessing.
    } catch (e) { toastCaught(e, 'Could not read that file') } finally { setParsing(false) }
  }

  const commit = async () => {
    if (!ready.length) return
    setCommitting(true)
    try {
      // Rows are written with the registry's own wording and id, so an import
      // starts life linked rather than needing the linking pass afterwards.
      const rows = ready.map(({ row, site }) => (site
        ? { ...row, centerName: site.name, siteId: site.id, entity: site.entity || row.entity || '' }
        : row))
      const res = await cfg.add(orgName, rows, { uid: profile?.uid, name: profile?.name })
      reset(); setDone(res)
      toast.success(`${res.created} ${cfg.label} added`)
    } catch (e) { toastCaught(e, 'Could not import', { action: 'import these assets' }) } finally { setCommitting(false) }
  }

  return (
    <div>
      <PageHeader title="Bulk Upload — Assets" subtitle={`Import many ${cfg.label} records from a spreadsheet. Every row is added as a new record with its own QR code.`} icon={Upload}>
        <div className="flex rounded-xl bg-surface-100 p-1 no-print">
          {Object.entries(CFG).map(([k, c]) => (
            <button key={k} onClick={() => switchKind(k)} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${kind === k ? 'bg-surface text-ink-900 shadow-elev-sm' : 'text-ink-500'}`}>{c.label}</button>
          ))}
        </div>
        <button className="btn-ghost" onClick={() => downloadAssetTemplate(kind)}><Download size={16} /> Download template</button>
      </PageHeader>

      {done ? (
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="card mx-auto max-w-lg p-8 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-green-100 text-green-600"><CheckCircle2 size={34} /></div>
          <h2 className="text-xl font-extrabold">Import complete</h2>
          <p className="mt-1 text-sm text-ink-500"><strong>{done.created}</strong> {cfg.label} record(s) added, each with a unique QR code.</p>
          <div className="mt-6 flex justify-center gap-3">
            <button className="btn-primary" onClick={reset}>Import more</button>
            <a className="btn-ghost" href={cfg.path}>View {cfg.label} repository</a>
          </div>
        </motion.div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]) }}
              className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl bg-surface-50 px-6 py-14 text-center ring-1 ring-ink-200 transition hover:bg-brand-50/40"
            >
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-500">
                {parsing ? <Loader2 className="animate-spin" /> : <FileSpreadsheet size={26} />}
              </div>
              <p className="font-bold text-ink-800">{fileName || 'Click to upload or drag & drop'}</p>
              <p className="text-sm text-ink-500">.xlsx or .csv using the {cfg.label} template columns</p>
            </button>
            {/* Outside the button: a <button> may not contain a form control,
                and the picker is opened through the ref either way. */}
            <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />

            {result && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="chip bg-green-100 text-green-700"><CheckCircle2 size={14} /> {ready.length} ready</span>
                  {suggested.length > 0 && <span className="chip bg-amber-100 text-amber-800"><AlertTriangle size={14} /> {suggested.length} need a site confirmed</span>}
                  {missing.length > 0 && <span className="chip bg-red-100 text-red-700"><MapPin size={14} /> {missing.length} site not available</span>}
                  {result.errors.length > 0 && <span className="chip bg-red-100 text-red-700"><AlertTriangle size={14} /> {result.errors.length} with issues</span>}
                  <span className="text-sm text-ink-500">{result.total} total rows</span>
                </div>

                {suggested.length > 0 && (
                  <div className="card overflow-hidden border border-amber-200">
                    <div className="flex items-center justify-between gap-3 border-b border-amber-100 bg-amber-50 px-4 py-2.5">
                      <span className="text-xs font-bold uppercase tracking-wide text-amber-700">Did you mean…?</span>
                      <button className="btn-soft !bg-amber-100 !text-amber-900 px-2.5 py-1 text-xs" onClick={acceptAll}>
                        <Wand2 size={14} /> Accept all {suggested.length}
                      </button>
                    </div>
                    <ul className="divide-y divide-ink-100 text-sm">
                      {suggestedPage.pageItems.map((c) => (
                        <li key={c.i} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5">
                          <strong>Row {c.i + 1}:</strong>
                          <span className="text-ink-500 line-through">{c.given || '(no site)'}</span>
                          <span className="text-ink-400">→</span>
                          <span className="font-semibold text-ink-900">{c.suggestion.name}</span>
                          <button
                            className="btn-soft ml-auto px-2.5 py-1 text-xs"
                            onClick={() => setPicked((p) => ({ ...p, [c.i]: c.suggestion.name }))}
                          >
                            Use this site
                          </button>
                        </li>
                      ))}
                    </ul>
                    <Pager
                      className="border-t border-ink-100 px-3 py-2"
                      page={suggestedPage.page}
                      pageCount={suggestedPage.pageCount}
                      onPage={suggestedPage.setPage}
                      total={suggestedPage.total}
                      pageSize={suggestedPage.pageSize}
                    />
                  </div>
                )}

                {missing.length > 0 && (
                  <div className="card overflow-hidden border border-red-200">
                    <div className="border-b border-red-100 bg-red-50 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-red-600">
                      Site is not available
                    </div>
                    <ul className="divide-y divide-ink-100 text-sm">
                      {[...new Set(missing.map((c) => c.given || '(no site)'))].slice(0, 12).map((name) => (
                        <li key={name} className="flex items-start gap-2 px-4 py-2.5">
                          <MapPin size={15} className="mt-0.5 shrink-0 text-red-500" />
                          <span>
                            <strong>{name}</strong> is not in the site registry. Add the site first, or correct the
                            spelling in your file — these rows will not be imported.
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {ready.length > 0 && (
                  <div className="card overflow-hidden">
                    <div className="border-b border-ink-100 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-ink-500">Preview ({ready.length})</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-100/70 text-left text-xs uppercase text-ink-400">
                          <tr>{cfg.cols.map(([h]) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {readyPage.pageItems.map((c) => (
                            <tr key={c.i}>{cfg.cols.map(([h, f]) => (
                              // Show the registry's wording, which is what will be written.
                              <td key={h} className="px-3 py-2">
                                {(f === 'centerName' && c.site ? c.site.name : c.row[f]) || '—'}
                              </td>
                            ))}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pager
                      className="border-t border-ink-100 px-3 py-2"
                      page={readyPage.page}
                      pageCount={readyPage.pageCount}
                      onPage={readyPage.setPage}
                      total={readyPage.total}
                      pageSize={readyPage.pageSize}
                    />
                  </div>
                )}

                {result.errors.length > 0 && (
                  <div className="card overflow-hidden border border-red-200">
                    <div className="border-b border-red-100 bg-red-50 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-red-600">Rows skipped</div>
                    <ul className="divide-y divide-ink-100 text-sm">
                      {errorsPage.pageItems.map((e, i) => (
                        <li key={i} className="flex items-start gap-2 px-4 py-2.5"><X size={15} className="mt-0.5 shrink-0 text-red-500" /><span><strong>Row {e.row}:</strong> {e.issues.join('; ')}</span></li>
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

                {result.valid.length > 0 && (
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    {suggested.length > 0 && (
                      <span className="mr-auto text-sm text-amber-700">
                        {suggested.length} row(s) are waiting on a site — confirm or fix them to include them.
                      </span>
                    )}
                    <button className="btn-ghost" onClick={reset}>Cancel</button>
                    <button className="btn-primary" onClick={commit} disabled={committing || !ready.length}>
                      {committing ? <Spinner size={18} /> : `Import ${ready.length} ${cfg.label}`}
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </div>

          <aside className="card h-fit space-y-3 p-6">
            <h3 className="text-sm font-bold uppercase tracking-wide text-ink-500">How it works</h3>
            <ol className="space-y-2 text-sm text-ink-600">
              <li>1. Pick <strong>{cfg.label}</strong> and download the template.</li>
              <li>2. Fill one {cfg.label} per row. <strong>Site</strong> is required.</li>
              <li>3. Upload — rows are validated against the allowed values.</li>
              <li>4. Review, then import. Each row becomes a new record with a QR code.</li>
            </ol>
            <div className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 ">
              <p className="mb-1 text-xs font-bold uppercase text-ink-500">Columns</p>
              <div className="flex flex-wrap gap-1.5">
                {cfg.columns.map((c) => <span key={c} className="chip bg-surface text-ink-600">{c}</span>)}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
