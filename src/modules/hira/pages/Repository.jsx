import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { FolderOpen, Filter, Search, X, FilePlus2, Eye, Pencil, Trash2, AlertTriangle, FileDown, Layers, Upload, ArrowRight } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, EmptyState, Modal, Skeleton, Field } from '../components/ui'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import { RiskBadge } from '../components/RiskBits'
import DocIdTag from '../../../shared/docId/DocIdTag'
import { useRa } from '../context/RaContext'
import { useAuth } from '../context/AuthContext'
import { deleteAssessment, logActivity } from '../lib/firestore'
import { residualRisk } from '../lib/raStats'
import { exportAssessmentPdf } from '../lib/pdf'

// Highest residual risk across an assessment's hazards (for the row badge).
function topRisk(a) {
  let best = null
  for (const act of a.activities || []) {
    for (const h of act.hazards || []) {
      const r = residualRisk(h)
      if (r && (!best || r.score > best.score)) best = r
    }
  }
  return best
}

function countHazards(a) {
  return (a.activities || []).reduce((n, act) => n + (act.hazards?.length || 0), 0)
}

const uniq = (arr) => Array.from(new Set(arr.filter(Boolean))).sort()

export default function Repository() {
  const { assessments, loading } = useRa()
  const { user, profile } = useAuth()
  const navigate = useNavigate()

  const [site, setSite] = useState('')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [search, setSearch] = useState('')
  const [chooserOpen, setChooserOpen] = useState(false)
  const [baselinePick, setBaselinePick] = useState('')
  const baselines = useMemo(() => assessments.filter((a) => a.kind === 'baseline'), [assessments])
  const [toDelete, setToDelete] = useState(null)

  const sites = useMemo(() => uniq(assessments.map((a) => a.siteName)), [assessments])
  const names = useMemo(() => uniq(assessments.map((a) => a.name)), [assessments])
  const locations = useMemo(() => uniq(assessments.map((a) => a.location)), [assessments])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return assessments.filter((a) => {
      if (a.kind === 'baseline') return false // baselines live in their own tab
      if (site && a.siteName !== site) return false
      if (name && a.name !== name) return false
      if (location && a.location !== location) return false
      if (q && !`${a.name} ${a.siteName} ${a.location}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [assessments, site, name, location, search])

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filtered)

  const filtersActive = site || name || location || search
  const clearAll = () => { setSite(''); setName(''); setLocation(''); setSearch('') }
  const totalHazards = useMemo(() => filtered.reduce((n, a) => n + countHazards(a), 0), [filtered])

  const confirmDelete = async () => {
    if (!toDelete) return
    try {
      await deleteAssessment(toDelete.id)
      logActivity({ uid: user?.uid, name: profile?.name }, {
        type: 'deleted',
        message: `deleted risk assessment “${toDelete.name}”`,
      })
      toast.success('Assessment deleted')
    } catch (e) {
      toastCaught(e, 'Could not delete')
    } finally {
      setToDelete(null)
    }
  }

  return (
    <div>
      <PageHeader tour="repository-header" title="Repository" subtitle="Browse and filter all risk assessments." icon={FolderOpen}>
        <button type="button" className="btn-primary" onClick={() => { setBaselinePick(''); setChooserOpen(true) }}>
          <FilePlus2 size={16} /> New assessment
        </button>
      </PageHeader>

      {/* Filter bar */}
      <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
        <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-ink-400">
          <Filter size={13} /> Filters
        </span>
        <div className="relative min-w-[200px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search name, site, location…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="input w-auto" value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="input w-auto" value={name} onChange={(e) => setName(e.target.value)}>
          <option value="">All names</option>
          {names.map((n) => <option key={n}>{n}</option>)}
        </select>
        <select className="input w-auto" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All locations</option>
          {locations.map((l) => <option key={l}>{l}</option>)}
        </select>
        {filtersActive && (
          <button className="btn-ghost px-2.5 py-1 text-xs" onClick={clearAll}><X size={12} /> Clear</button>
        )}
        <span className="ml-auto text-xs font-semibold text-ink-400">
          {filtered.length} assessment{filtered.length === 1 ? '' : 's'} · {totalHazards} hazard{totalHazards === 1 ? '' : 's'}
        </span>
      </div>

      {loading && assessments.length === 0 ? (
        <div className="card overflow-hidden p-4">
          <Skeleton className="mb-3 h-6 w-1/3" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-t border-surface-100 py-3">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title={loading ? 'Loading…' : filtersActive ? 'No assessments match your filters' : 'No assessments yet'}
          hint={filtersActive ? 'Try clearing the filters.' : 'Create your first risk assessment to see it here.'}
          action={!filtersActive && (
            <button type="button" className="btn-primary mt-2" onClick={() => { setBaselinePick(''); setChooserOpen(true) }}>
              <FilePlus2 size={16} /> Create assessment
            </button>
          )}
        />
      ) : (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-100/70 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3 text-center">Activities</th>
                  <th className="px-4 py-3 text-center">Hazards</th>
                  <th className="px-4 py-3">Top Risk</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {pageItems.map((a) => {
                  const r = topRisk(a)
                  return (
                    <tr key={a.id} className="group cursor-pointer transition hover:bg-surface-100/40" onClick={() => navigate(`/hira/assessment/${a.id}`)}>
                      <td className="px-4 py-3 font-semibold text-ink-900">{a.name}<DocIdTag id={a.docId} className="mt-0.5 block" /></td>
                      <td className="px-4 py-3">{a.siteName || '—'}</td>
                      <td className="px-4 py-3">{a.location || '—'}</td>
                      <td className="px-4 py-3">{a.assessmentDate || '—'}</td>
                      <td className="px-4 py-3 text-center">{a.activities?.length || 0}</td>
                      <td className="px-4 py-3 text-center">{countHazards(a)}</td>
                      <td className="px-4 py-3"><RiskBadge risk={r} size="sm" /></td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                          {/* Named by the assessment, not the verb: four rows of
                              "View, Export, Edit, Delete" read out of the table
                              give no way to tell which assessment is which. */}
                          <Link to={`/hira/assessment/${a.id}`} className="rounded-lg p-2 text-ink-500 shadow-elev-sm transition hover:bg-surface-100 hover:text-ink-800" aria-label={`View assessment ${a.name || a.docId || a.id}`} title="View"><Eye size={16} /></Link>
                          <button onClick={() => { try { exportAssessmentPdf(a) } catch (err) { toastCaught(err, 'Could not export PDF') } }} className="rounded-lg p-2 text-ink-500 shadow-elev-sm transition hover:bg-surface-100 hover:text-ink-800" aria-label={`Export assessment ${a.name || a.docId || a.id} as PDF`} title="Export PDF"><FileDown size={16} /></button>
                          <Link to={`/hira/create/${a.id}`} className="rounded-lg p-2 text-ink-500 shadow-elev-sm transition hover:bg-surface-100 hover:text-ink-800" aria-label={`Edit assessment ${a.name || a.docId || a.id}`} title="Edit"><Pencil size={16} /></Link>
                          <button onClick={() => setToDelete(a)} className="rounded-lg p-2 text-red-500 shadow-elev-sm transition hover:bg-red-50" aria-label={`Delete assessment ${a.name || a.docId || a.id}`} title="Delete"><Trash2 size={16} /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager
            className="border-t border-ink-100 px-3 py-2"
            page={page}
            pageCount={pageCount}
            onPage={setPage}
            total={total}
            pageSize={pageSize}
          />
        </motion.div>
      )}

      <Modal open={Boolean(toDelete)} onClose={() => setToDelete(null)} title="Delete assessment?">
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-700">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>This permanently removes <strong>{toDelete?.name}</strong> and all its activities, hazards and controls. This cannot be undone.</span>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setToDelete(null)}>Cancel</button>
            <button className="btn-danger" onClick={confirmDelete}><Trash2 size={16} /> Delete</button>
          </div>
        </div>
      </Modal>

      {/* New-assessment chooser */}
      <Modal
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        title="New Risk Assessment"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => { setChooserOpen(false); navigate('/hira/create') }}
              className="card flex flex-col items-center gap-2 p-5 text-center transition-transform duration-200 ease-emil hover:-translate-y-0.5 active:scale-[0.99]"
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-700 shadow-elev-sm"><FilePlus2 size={22} /></span>
              <span className="font-semibold text-ink-900">New assessment</span>
              <span className="text-xs text-ink-400">Start from a blank form</span>
            </button>

            <button
              type="button"
              onClick={() => setBaselinePick(baselinePick === 'open' ? '' : 'open')}
              className={`card flex flex-col items-center gap-2 p-5 text-center transition-transform duration-200 ease-emil hover:-translate-y-0.5 active:scale-[0.99] ${baselinePick === 'open' ? 'ring-2 ring-brand-300' : ''}`}
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-violet-50 text-violet-600 shadow-elev-sm"><Layers size={22} /></span>
              <span className="font-semibold text-ink-900">Create from baseline</span>
              <span className="text-xs text-ink-400">Reuse an activity template</span>
            </button>

            <button
              type="button"
              onClick={() => { setChooserOpen(false); navigate('/hira/bulk-import') }}
              className="card flex flex-col items-center gap-2 p-5 text-center transition-transform duration-200 ease-emil hover:-translate-y-0.5 active:scale-[0.99]"
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-50 text-emerald-600 shadow-elev-sm"><Upload size={22} /></span>
              <span className="font-semibold text-ink-900">Bulk import</span>
              <span className="text-xs text-ink-400">Upload a CSV</span>
            </button>
          </div>

          {baselinePick === 'open' && (
            <Field label="Choose a baseline to build from" className="well rounded-2xl p-4">
              {baselines.length === 0 ? (
                <p className="text-sm text-ink-500">
                  No baselines yet.{' '}
                  <Link to="/hira/create?kind=baseline" className="font-semibold text-brand-700 hover:underline" onClick={() => setChooserOpen(false)}>
                    Create a baseline
                  </Link>{' '}
                  first.
                </p>
              ) : (
                <div className="space-y-2">
                  {baselines.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => { setChooserOpen(false); navigate(`/hira/create?from=${b.id}`) }}
                      className="flex w-full items-center justify-between rounded-xl bg-surface px-3.5 py-2.5 text-left shadow-elev-sm transition hover:bg-surface-100 active:scale-[0.99]"
                    >
                      <span>
                        <span className="block text-sm font-medium text-ink-900">{b.name}</span>
                        <span className="block text-xs text-ink-400">{(b.activities || []).length} activities</span>
                      </span>
                      <ArrowRight size={16} className="text-brand-600" />
                    </button>
                  ))}
                </div>
              )}
            </Field>
          )}
        </div>
      </Modal>
    </div>
  )
}
