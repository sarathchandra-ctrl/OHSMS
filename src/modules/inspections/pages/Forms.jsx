import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import {
  ClipboardList, Plus, Pencil, Trash2, CalendarPlus, Search, ListChecks, MapPin, PlayCircle,
} from 'lucide-react'
import { PageHeader, EmptyState, StatusPill } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { deleteTemplate, setTemplateStatus, updateTemplateAssignments } from '../lib/firestore'
import { isOnDemand } from '../lib/schedule'
import InspectionAssignmentsModal from './Inspections/InspectionAssignmentsModal'

export default function Forms() {
  const navigate = useNavigate()
  const { profile, isAdmin } = useAuth()
  const { templates } = useData()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [assignTemplate, setAssignTemplate] = useState(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return templates.filter((t) => {
      if (statusFilter !== 'All' && t.status !== statusFilter) return false
      if (!q) return true
      return (t.title || '').toLowerCase().includes(q) || (t.siteName || '').toLowerCase().includes(q)
    })
  }, [templates, search, statusFilter])

  const pendingCount = (t) => (Array.isArray(t.assignments) ? t.assignments.filter((a) => a.status === 'Pending').length : 0)
  // Distinct site names this form is currently assigned to.
  const assignedSites = (t) => {
    const names = (Array.isArray(t.assignments) ? t.assignments : [])
      .filter((a) => a.status === 'Pending' && a.siteName)
      .map((a) => a.siteName)
    return Array.from(new Set(names))
  }

  const handleStatus = async (t, status) => {
    try { await setTemplateStatus(t.id, status) }
    catch (e) { toastCaught(e, 'Could not update status') }
  }

  const handleDelete = async (t) => {
    if (!isAdmin) return
    if (!window.confirm(`Permanently delete "${t.title}"?`)) return
    try { await deleteTemplate(t.id, t.title, profile); toast.success('Form deleted') }
    catch (e) { toastCaught(e, 'Delete failed') }
  }

  // An on-demand form never reaches the calendar, so this is the only way to
  // run one without first inventing a date for it — which would be recording a
  // schedule that does not exist purely to satisfy the scheduler.
  //
  // The task is shaped exactly like a scheduled one so Execute needs no special
  // case, minus dueString: there is no due date, and passing today's would make
  // the record claim it was scheduled for today.
  const startNow = (t) => {
    if (!(t.fields?.length > 0)) return toast.error('Add at least one question before running this form.')
    navigate('/inspections/execute', {
      state: {
        task: {
          templateId: t.id,
          title: t.title,
          siteId: t.siteId || '',
          siteName: t.siteName || '',
          area: '',
          frequency: t.frequency,
          dueDate: null,
          dueString: '',
          template: t,
        },
      },
    })
  }

  const saveAssignments = async (next) => {
    await updateTemplateAssignments(assignTemplate.id, next, profile)
    setAssignTemplate((prev) => (prev ? { ...prev, assignments: next } : prev))
    toast.success('Assignments saved')
  }

  return (
    <div>
      <PageHeader icon={ClipboardList} title="Inspection forms" subtitle={`${templates.length} form${templates.length === 1 ? '' : 's'} in your organization`}>
        <button className="btn-primary" onClick={() => navigate('/inspections/forms/new')}>
          <Plus size={16} /> Create form
        </button>
      </PageHeader>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input className="input pl-9" placeholder="Search forms…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2">
          {['All', 'Active', 'Draft', 'Inactive'].map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`chip ${statusFilter === s ? 'bg-brand-500 text-white' : 'bg-surface text-ink-600'}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={templates.length === 0 ? 'No inspection forms yet' : 'No forms match your filters'}
          hint={templates.length === 0 ? 'Create your first inspection form to start scheduling checks.' : 'Try a different search or status filter.'}
          action={templates.length === 0 && <button className="btn-primary mt-2" onClick={() => navigate('/inspections/forms/new')}><Plus size={16} /> Create form</button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((t) => (
            <div key={t.id} className="card flex flex-col p-5">
              <div className="mb-2 flex items-start justify-between gap-2">
                <h3 className="font-bold text-ink-900">{t.title}</h3>
                <StatusPill status={t.status} />
              </div>
              {t.desc && <p className="mb-3 line-clamp-2 text-sm text-ink-500">{t.desc}</p>}
              <div className="mb-3 flex flex-wrap gap-3 text-xs text-ink-500">
                <span className="inline-flex items-center gap-1"><ListChecks size={13} /> {t.fields?.length || 0} questions</span>
                <span className="inline-flex items-center gap-1"><CalendarPlus size={13} /> {t.frequency}</span>
                {t.siteName && <span className="inline-flex items-center gap-1"><MapPin size={13} /> {t.siteName}</span>}
                {pendingCount(t) > 0 && <span className="inline-flex items-center gap-1 font-semibold text-brand-600">{pendingCount(t)} scheduled</span>}
              </div>
              {assignedSites(t).length > 0 && (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {assignedSites(t).map((name) => (
                    <span key={name} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                      <MapPin size={10} /> {name}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-auto flex flex-wrap items-center gap-2">
                {/* Only while Active, matching the condition the scheduler uses
                    to pick a form up. A Draft is unfinished and an Inactive one
                    was deliberately retired; neither should be runnable from a
                    button that exists because there is no due date to stop you. */}
                {isOnDemand(t.frequency) && t.status === 'Active' && (
                  <button className="btn-primary flex-1 text-xs" onClick={() => startNow(t)}>
                    <PlayCircle size={14} /> Start now
                  </button>
                )}
                <button className="btn-soft flex-1 text-xs" onClick={() => setAssignTemplate(t)}>
                  <CalendarPlus size={14} /> Assign
                </button>
                <button className="btn-ghost text-xs" onClick={() => navigate(`/inspections/forms/${t.id}/edit`)}>
                  <Pencil size={14} /> Edit
                </button>
                <select
                  className="rounded-xl bg-surface px-2 py-1.5 text-xs font-semibold text-ink-600  outline-hidden"
                  value={t.status}
                  onChange={(e) => handleStatus(t, e.target.value)}
                  title="Change status"
                >
                  <option value="Draft">Draft</option>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
                {isAdmin && (
                  <button className="rounded-xl p-2 text-ink-400 transition hover:bg-red-50 hover:text-red-600" onClick={() => handleDelete(t)} title="Delete">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {assignTemplate && (
        <InspectionAssignmentsModal
          template={assignTemplate}
          currentUserEmail={profile?.email}
          onClose={() => setAssignTemplate(null)}
          onSave={saveAssignments}
        />
      )}
    </div>
  )
}
