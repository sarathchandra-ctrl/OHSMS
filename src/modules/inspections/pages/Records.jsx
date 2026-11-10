import { StoredImage } from '../../../shared/storage/StoredImage'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { History, Search, Trash2, MapPin, User, Calendar } from 'lucide-react'
import { PageHeader, EmptyState, Modal, StatusPill } from '../components/ui'
import SiteFilter from '../components/SiteFilter'
import { Pager } from '../../../shared/ui'
import { usePagination } from '../../../shared/ui/usePagination'
import DocIdTag from '../../../shared/docId/DocIdTag'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { deleteRecord } from '../lib/data'

function RecordDetail({ record, onClose }) {
  const findings = Object.values(record.responses || {}).filter(
    (r) => r?.answer === 'Fail' || String(r?.observation || '').trim()
  )
  return (
    <Modal open onClose={onClose} title={record.templateTitle} maxWidth="max-w-2xl">
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-ink-500">
        <StatusPill status={record.passFailResult} />
        <span className="text-lg font-black text-ink-800">{record.score}%</span>
        <span className="inline-flex items-center gap-1"><User size={13} /> {record.inspector}</span>
        <span className="inline-flex items-center gap-1"><Calendar size={13} /> {new Date(record.completedAt).toLocaleString()}</span>
        {(record.siteName || record.location) && <span className="inline-flex items-center gap-1"><MapPin size={13} /> {record.siteName || record.location}{record.area ? ` · ${record.area}` : ''}</span>}
      </div>

      {findings.length > 0 && (
        <div className="mb-4 rounded-2xl bg-red-50 p-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-red-600">Findings ({findings.length})</p>
          <ul className="space-y-2">
            {findings.map((f, i) => (
              <li key={i} className="text-sm">
                <span className="font-semibold text-ink-800">{f.label}</span>
                {f.observation && <span className="text-ink-600"> — {f.observation}</span>}
                {(f.photoEvidence || f.photoEvidencePath) && <StoredImage pointer={{ url: f.photoEvidence, path: f.photoEvidencePath }} alt="" className="mt-1.5 h-20 w-20 rounded-lg object-cover shadow-elev-sm" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-500">All responses</p>
      <div className="space-y-2">
        {Object.values(record.responses || {}).map((r, i) => {
          const ans = Array.isArray(r.answer) ? r.answer.join(', ') : r.answer
          return (
            <div key={i} className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2 text-sm shadow-elev-sm">
              <span className="text-ink-700">{r.label}</span>
              <span className={`text-right font-bold ${r.answer === 'Pass' ? 'text-emerald-600' : r.answer === 'Fail' ? 'text-red-600' : 'text-ink-500'}`}>
                {ans || '—'}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

export default function Records() {
  const location = useLocation()
  const { profile, isAdmin } = useAuth()
  const { filteredRecords } = useData()
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(null)

  useEffect(() => {
    const rid = location.state?.recordId
    if (rid) {
      const found = filteredRecords.find((r) => r.id === rid)
      if (found) setActive(found)
    }
  }, [location.state, filteredRecords])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return filteredRecords
    return filteredRecords.filter((r) =>
      (r.templateTitle || '').toLowerCase().includes(q) ||
      (r.siteName || r.location || '').toLowerCase().includes(q) ||
      (r.inspector || '').toLowerCase().includes(q)
    )
  }, [filteredRecords, search])

  const { pageItems, page, setPage, pageCount, total, pageSize } = usePagination(filtered)

  const handleDelete = async (r) => {
    if (!isAdmin) return
    if (!window.confirm('Permanently delete this inspection record?')) return
    try { await deleteRecord(r.id, r.templateTitle, profile); toast.success('Record deleted') }
    catch (e) { toastCaught(e, 'Delete failed') }
  }

  return (
    <div>
      <PageHeader icon={History} title="Inspection records" subtitle={`${filtered.length} completed inspection${filtered.length === 1 ? '' : 's'}`}>
        <SiteFilter />
      </PageHeader>

      <div className="relative mb-5 max-w-md">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input className="input pl-9" placeholder="Search by form, site or inspector…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={History} title="No records yet" hint="Completed inspections will appear here once submitted." />
      ) : (
        <div className="overflow-hidden card">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface text-[10px] uppercase tracking-widest text-ink-400">
              <tr>
                <th className="px-4 py-3">Form</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Inspector</th>
                <th className="px-4 py-3">Completed</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-surface-200/60 hover:bg-surface/60" onClick={() => setActive(r)}>
                  <td className="px-4 py-3 font-semibold text-ink-800">{r.templateTitle}<DocIdTag id={r.docId} className="mt-0.5 block" /></td>
                  <td className="px-4 py-3 text-ink-500">{r.siteName || r.location || '—'}</td>
                  <td className="px-4 py-3 text-ink-500">{r.inspector}</td>
                  <td className="px-4 py-3 text-ink-500">{new Date(r.completedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3"><span className={`font-bold ${r.passFailResult === 'PASS' ? 'text-emerald-600' : 'text-red-600'}`}>{r.score}% {r.passFailResult}</span></td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {isAdmin && (
                      <button className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600" onClick={() => handleDelete(r)}><Trash2 size={15} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            className="border-t border-surface-200/60 px-3 py-2"
            page={page} pageCount={pageCount} onPage={setPage} total={total} pageSize={pageSize}
          />
        </div>
      )}

      {active && <RecordDetail record={active} onClose={() => setActive(null)} />}
    </div>
  )
}
