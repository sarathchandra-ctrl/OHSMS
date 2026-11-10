import { useRef, useState, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle, X, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, Spinner } from '../components/ui'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { useAuth } from '../context/AuthContext'
import { parseCsv, downloadTemplate, previewRows, CSV_COLUMNS } from '../lib/csv'
import { bulkCreateAssessments, logActivity } from '../lib/data'

export default function BulkImport() {
  const { profile, user } = useAuth()
  const inputRef = useRef(null)
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState(null) // { assessments, errors, totalRows }
  const [committing, setCommitting] = useState(false)
  const [done, setDone] = useState(null) // { created }
  const [importKind, setImportKind] = useState('site') // 'site' | 'baseline'
  const [file, setFile] = useState(null)

  const preview = useMemo(() => (result ? previewRows(result.assessments) : []), [result])

  // Hazard preview and error list page separately — a CSV of a few hundred
  // hazards is a few hundred rows of DOM. `commit` still imports every parsed
  // assessment, not the visible page.
  const previewPage = usePagination(preview)
  const errorsPage = usePagination(result?.errors || [])

  // Parse (and re-validate) whenever the file OR the import kind changes — so
  // toggling Baseline/Site re-checks the Region/Entity/Site requirement.
  useEffect(() => {
    if (!file) return
    let alive = true
    setParsing(true)
    setResult(null)
    parseCsv(file, importKind)
      .then((r) => {
        if (!alive) return
        setResult(r)
        if (r.assessments.length === 0) toast.error('No valid rows found')
        else toast.success(`${r.assessments.length} ${importKind === 'baseline' ? 'baseline' : 'assessment'}(s) ready`)
      })
      .catch(() => alive && toast.error('Could not read that file'))
      .finally(() => alive && setParsing(false))
    return () => { alive = false }
  }, [file, importKind])

  const handleFile = (f) => {
    if (!f) return
    if (f.size > 15 * 1024 * 1024) return toast.error('File size exceeds 15MB limit.')
    setFileName(f.name)
    setFile(f)
  }

  const commit = async () => {
    if (!result?.assessments.length) return
    setCommitting(true)
    try {
      const created = await bulkCreateAssessments(result.assessments, { uid: user?.uid, name: profile?.name }, importKind)
      logActivity({ uid: user?.uid, name: profile?.name }, {
        type: 'imported',
        message: `imported ${created} ${importKind === 'baseline' ? 'baseline' : 'risk'} assessment(s) from CSV`,
      })
      setDone({ created })
      toast.success(`${created} assessment(s) imported`)
      setResult(null)
      setFileName('')
    } catch (e) {
      toastCaught(e, 'Import failed')
    } finally {
      setCommitting(false)
    }
  }

  const reset = () => { setResult(null); setFileName(''); setDone(null); setFile(null) }

  const totalHazards = preview.length

  return (
    <div>
      <PageHeader
        title="Bulk Import"
        subtitle="Import risk assessments from a CSV. One row per hazard/control; rows are grouped automatically."
        icon={Upload}
      >
        <button className="btn-ghost" onClick={() => downloadTemplate(importKind)}>
          <Download size={16} /> Download {importKind === 'baseline' ? 'baseline' : 'site'} template
        </button>
      </PageHeader>

      {done ? (
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="card mx-auto max-w-lg p-8 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-green-100 text-green-600">
            <CheckCircle2 size={34} />
          </div>
          <h2 className="text-xl font-extrabold">Import complete</h2>
          <p className="mt-1 text-sm text-ink-500"><strong>{done.created}</strong> assessment(s) added.</p>
          <div className="mt-6 flex justify-center gap-3">
            <button className="btn-primary" onClick={reset}>Import more</button>
            <Link className="btn-ghost" to="/hira/repository">View repository</Link>
          </div>
        </motion.div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <div className="card p-4">
              <p className="label mb-2">Import as</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                {[
                  { key: 'site', label: 'Normal (site) assessment', hint: 'Site-level risk assessments' },
                  { key: 'baseline', label: 'Baseline template', hint: 'Reusable activity-level templates' },
                ].map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => setImportKind(o.key)}
                    className={`flex-1 rounded-2xl border p-3 text-left transition active:scale-[0.99] ${
                      importKind === o.key ? 'border-brand-400 bg-brand-50 shadow-elev-sm' : 'border-ink-200 hover:bg-surface-100'
                    }`}
                  >
                    <p className="text-sm font-semibold text-ink-900">{o.label}</p>
                    <p className="text-xs text-ink-400">{o.hint}</p>
                  </button>
                ))}
              </div>
            </div>
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
              <p className="text-sm text-ink-500">.csv using the template columns</p>
            </button>
            {/* Outside the button: a <button> may not contain a form control,
                and the picker is opened through the ref either way. */}
            <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />

            {result && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="chip bg-green-100 text-green-700"><CheckCircle2 size={14} /> {result.assessments.length} assessments</span>
                  <span className="chip bg-indigo-100 text-indigo-700">{totalHazards} hazards</span>
                  {result.errors.length > 0 && (
                    <span className="chip bg-red-100 text-red-700"><AlertTriangle size={14} /> {result.errors.length} rows skipped</span>
                  )}
                  <span className="text-sm text-ink-500">{result.totalRows} total rows</span>
                </div>

                {preview.length > 0 && (
                  <div className="card overflow-hidden">
                    <div className="border-b border-ink-100 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-ink-500">
                      Preview ({preview.length} hazards)
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-100/70 text-left text-xs uppercase text-ink-400">
                          <tr>
                            <th className="px-3 py-2">Assessment</th>
                            <th className="px-3 py-2">Site</th>
                            <th className="px-3 py-2">Activity</th>
                            <th className="px-3 py-2">Hazard</th>
                            <th className="px-3 py-2">Risk</th>
                            <th className="px-3 py-2">Controls</th>
                            <th className="px-3 py-2">ALARP</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {previewPage.pageItems.map((r, i) => (
                            <tr key={i}>
                              <td className="px-3 py-2 font-semibold">{r.assessment}</td>
                              <td className="px-3 py-2">{r.site || '—'}</td>
                              <td className="px-3 py-2">{r.activity}</td>
                              <td className="px-3 py-2">{r.hazard}</td>
                              <td className="px-3 py-2">{r.risk}</td>
                              <td className="px-3 py-2">{r.controls}</td>
                              <td className="px-3 py-2">{r.alarp}</td>
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
                    <div className="border-b border-red-100 bg-red-50 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-red-600">Rows skipped</div>
                    <ul className="divide-y divide-ink-100 text-sm">
                      {errorsPage.pageItems.map((e, i) => (
                        <li key={i} className="flex items-start gap-2 px-4 py-2.5">
                          <X size={15} className="mt-0.5 shrink-0 text-red-500" />
                          <span><strong>Row {e.row}:</strong> {e.issues.join('; ')}</span>
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

                {result.assessments.length > 0 && (
                  <div className="flex justify-end gap-3">
                    <button className="btn-ghost" onClick={reset}>Cancel</button>
                    <button className="btn-primary" onClick={commit} disabled={committing}>
                      {committing ? <Spinner size={18} /> : `Import ${result.assessments.length} ${importKind === 'baseline' ? 'baseline(s)' : 'assessment(s)'}`}
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </div>

          <aside className="card h-fit space-y-3 p-6">
            <h3 className="text-sm font-bold uppercase tracking-wide text-ink-500">How it works</h3>
            <ol className="space-y-2 text-sm text-ink-600">
              <li>1. Download the template.</li>
              <li>2. One row per hazard. Repeat rows (same assessment + activity + hazard) to add more controls.</li>
              <li>3. Upload — rows are validated and grouped into assessments.</li>
              <li>4. Review the preview, then import.</li>
            </ol>
            <div className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 text-xs text-ink-600 ">
              Responsible-person names become <strong>internal members</strong> automatically. Set
              <strong> ALARP = Yes</strong> to skip additional controls &amp; projected risk.
            </div>
            <div className="ring-1 ring-ink-200 rounded-2xl bg-surface-50 p-3 ">
              <p className="mb-1 text-xs font-bold uppercase text-ink-500">Columns</p>
              <div className="flex flex-wrap gap-1.5">
                {CSV_COLUMNS.map((c) => (
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
