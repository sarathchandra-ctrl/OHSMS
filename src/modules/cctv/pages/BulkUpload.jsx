import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Upload, Download, HardDrive, Cctv, CircleCheck, TriangleAlert } from 'lucide-react'
import { PageHeader, Button, AccessDenied } from '../../../shared/ui'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useCctv } from '../context/CctvContext'
import { parseImport, DVR_COLUMNS, CAMERA_COLUMNS } from '../lib/bulkImport'
import { downloadImportTemplate } from '../lib/exporter'
import { bulkImport } from '../lib/firestore'
import { assertWorkbookSize } from '../../../shared/lib/workbookGuard'

const KINDS = {
  dvrs: { label: 'DVR', icon: HardDrive, columns: DVR_COLUMNS },
  cameras: { label: 'Cameras', icon: Cctv, columns: CAMERA_COLUMNS },
}

/**
 * Import DVRs and cameras from a spreadsheet.
 *
 * Two things shape this page. Order matters — a camera references its DVR by
 * name, so importing cameras into an empty DVR list fails every row, and the
 * page says so before the upload rather than after. And nothing is written
 * until the whole file has been checked: an import that half-succeeds leaves
 * someone reconciling a spreadsheet against a database by hand.
 */
export default function BulkUpload() {
  const { actor, isManager } = useAuth()
  const { sites, dvrs, cameras } = useCctv()
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [kind, setKind] = useState('dvrs')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  const cfg = KINDS[kind]

  const pick = (next) => { setKind(next); setResult(null) }

  const handleFile = async (file) => {
    if (!file) return
    setBusy(true)
    setResult(null)
    try {
      // Size is checked BEFORE the read, not after. parseImport checks it too,
      // but by then the whole file is already in memory — which is the thing
      // the limit exists to prevent. A 200 MB workbook does not need a CVE to
      // take the tab down.
      assertWorkbookSize(file.size, file.name)
      const buffer = await file.arrayBuffer()
      const parsed = parseImport(buffer, kind, { sites, dvrs, cameras })
      setResult({ ...parsed, fileName: file.name })
      if (!parsed.headerOk) toast.error('That file does not match the template')
      else if (!parsed.valid.length) toast.error('No row could be imported — see the reasons below')
    } catch (e) {
      toast.error(`Could not read the file: ${e.message}`)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const commit = async () => {
    setBusy(true)
    try {
      const n = await bulkImport(kind, result.valid.map((r) => r.data), actor)
      toast.success(`Imported ${n} ${cfg.label}`)
      navigate('/cctv/inventory')
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  if (!isManager) {
    return (
      <>
        <PageHeader title="Bulk import" />
        <AccessDenied description="Ask an admin or manager to run the import." />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Bulk import"
        subtitle="Add DVRs and cameras from a spreadsheet"
        actions={
          <Button variant="ghost" icon={Download} onClick={() => downloadImportTemplate(kind, { sites, dvrs })}>
            Download {cfg.label} template
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(KINDS).map(([k, c]) => (
          <button
            key={k}
            type="button"
            onClick={() => pick(k)}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
              kind === k ? 'bg-magenta-500 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
            }`}
          >
            <c.icon size={14} /> {c.label}
          </button>
        ))}
      </div>

      {/* The mistake almost everyone makes on the first run. */}
      {kind === 'cameras' && dvrs.length === 0 && (
        <div className="card mb-4 flex items-start gap-2.5 p-4 text-sm text-amber-800">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            There are no DVRs yet. A camera records to one and is matched by its DVR&apos;s name, so every row
            would fail — <b>import the DVRs first</b>.
          </span>
        </div>
      )}

      {sites.length === 0 && (
        <div className="card mb-4 flex items-start gap-2.5 p-4 text-sm text-amber-800">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            No sites are set up. Site names in the sheet are checked against the registry, so add your sites
            first — each one also gets its Meraki automatically.
          </span>
        </div>
      )}

      <div className="card p-6">
        <div className="text-sm font-semibold text-ink-800">Columns</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {cfg.columns.map((c) => (
            <span key={c} className="rounded-lg bg-ink-100 px-2 py-1 font-mono text-xs text-ink-600">{c}</span>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-500">
          Common alternatives are accepted (&ldquo;IP&rdquo; for &ldquo;IP Address&rdquo;, &ldquo;Branch&rdquo; for
          &ldquo;Site&rdquo;). {kind === 'cameras' ? 'Site is optional — a camera inherits its DVR’s site. ' : ''}
          A blank Status means &ldquo;not reported&rdquo; rather than online.
        </p>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="mt-4 flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-ink-200 px-6 py-8 transition hover:border-ink-400 hover:bg-ink-50 disabled:opacity-50"
        >
          <Upload size={22} className="text-ink-400" />
          <span className="text-sm font-semibold text-ink-700">
            {busy ? 'Reading…' : `Choose a ${cfg.label} file`}
          </span>
          <span className="text-xs text-ink-500">.xlsx, .xls or .csv</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>

      {result && !result.headerOk && (
        <div className="card mt-4 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-700">
            <TriangleAlert size={16} /> {result.fileName} does not look like the {cfg.label} template
          </div>
          <p className="mt-2 text-xs text-ink-500">
            Found columns: {result.headers.length ? result.headers.join(', ') : '(none)'}. Download the template
            above and copy your data into it.
          </p>
        </div>
      )}

      {result?.headerOk && (
        <div className="card mt-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
              <CircleCheck size={16} className="text-green-600" /> {result.valid.length} ready
            </span>
            {result.invalid.length > 0 && (
              <span className="flex items-center gap-1.5 text-sm font-semibold text-red-700">
                <TriangleAlert size={16} /> {result.invalid.length} cannot be imported
              </span>
            )}
            <span className="text-xs text-ink-500">of {result.total} rows in {result.fileName}</span>
            {result.valid.length > 0 && (
              <Button className="ml-auto" loading={busy} onClick={commit}>
                Import {result.valid.length} {cfg.label}
              </Button>
            )}
          </div>

          {result.invalid.length > 0 && (
            <>
              {/* Listed rather than summarised: the fix is per row, in their file. */}
              <div className="mt-3 max-h-64 overflow-y-auto rounded-xl bg-red-50 p-3">
                <table className="w-full text-xs">
                  <thead className="text-left text-red-900/70">
                    <tr><th className="pb-1 pr-3">Row</th><th className="pb-1 pr-3">Name</th><th className="pb-1">Why</th></tr>
                  </thead>
                  <tbody className="text-red-800">
                    {result.invalid.map((r) => (
                      <tr key={r.row} className="align-top">
                        <td className="py-0.5 pr-3 font-mono">{r.row}</td>
                        <td className="py-0.5 pr-3">{r.data.name || <em>blank</em>}</td>
                        <td className="py-0.5">{r.errors.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-500">
                Importing now brings in the {result.valid.length} valid row
                {result.valid.length === 1 ? '' : 's'} only. Fix the rest in your file and upload it again —
                anything already imported is skipped by name.
              </p>
            </>
          )}
        </div>
      )}
    </>
  )
}
