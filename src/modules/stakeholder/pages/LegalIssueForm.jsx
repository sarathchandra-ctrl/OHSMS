import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { ChevronLeft, Save, Trash2, TriangleAlert } from 'lucide-react'
import {
  PageHeader, Button, Field, Input, Select, Textarea, SkeletonDetail, EmptyState, AccessDenied,
} from '../../../shared/ui'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useStakeholder } from '../context/StakeholderContext'
import { addLegalIssue, updateLegalIssue, deleteLegalIssue } from '../lib/firestore'
import {
  DEPARTMENTS, DEPARTMENT_GROUPS, NOTICE_TYPES, NOTICE_BY_KEY, LEGAL_STATUS,
} from '../lib/constants'
import CapaEditor from '../components/CapaEditor'

const EMPTY = {
  title: '', scope: {}, escalationId: '', incidentDate: '', description: '',
  departments: [], departmentOther: '', officials: '',
  noticeType: 'none', noticeRef: '', noticeDate: '', responseDueDate: '',
  status: 'open', penaltyAmount: '', owner: '',
  capa: [],
}

/**
 * A full page, for the same reason as the escalation form.
 *
 * The department picker alone is eighteen options across six groups — in a
 * modal it scrolled past the notice fields that determine whether anything has
 * a deadline. On its own route it survives a refresh, which matters here more
 * than anywhere: this is filled in while an inspector is still on site.
 */
export default function LegalIssueForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { actor, isManager } = useAuth()
  const { legalIssues, sites, escalationOptions, loading } = useStakeholder()

  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    if (!id || hydrated || loading) return
    const found = legalIssues.find((l) => l.id === id)
    if (found) {
      setForm({ ...EMPTY, ...found })
      setHydrated(true)
    }
  }, [id, legalIssues, loading, hydrated])

  const patch = (p) => setForm((f) => ({ ...f, ...p }))
  const toggleDept = (key) =>
    patch({
      departments: form.departments.includes(key)
        ? form.departments.filter((d) => d !== key)
        : [...form.departments, key],
    })

  const save = async () => {
    if (!form.title.trim()) return toast.error('Give the legal issue a title')
    if (!form.departments.length) return toast.error('Which department was involved?')
    if (form.departments.includes('other') && !form.departmentOther.trim()) {
      return toast.error('Name the other department')
    }
    setBusy(true)
    try {
      if (id) await updateLegalIssue(id, form, actor)
      else await addLegalIssue(form, actor)
      toast.success(id ? 'Saved' : 'Legal issue logged')
      navigate('/stakeholder/legal')
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this legal issue?')) return
    try {
      await deleteLegalIssue(id, form.title, actor)
      toast.success('Deleted')
      navigate('/stakeholder/legal')
    } catch (e) {
      toastCaught(e)
    }
  }

  if (!isManager) {
    return <AccessDenied description="Ask an admin or manager to log legal issues." />
  }
  if (id && loading && !hydrated) return <SkeletonDetail />
  if (id && !loading && !hydrated) {
    return (
      <EmptyState
        title="Legal issue not found"
        hint="It may have been deleted."
        action={<Button onClick={() => navigate('/stakeholder/legal')}>Back to legal issues</Button>}
      />
    )
  }

  const severe = NOTICE_BY_KEY[form.noticeType]?.severe

  return (
    <>
      <PageHeader
        title={id ? 'Edit legal issue' : 'Log legal issue'}
        subtitle={form.docId || undefined}
        actions={
          <div className="flex gap-2">
            {id && <Button variant="ghost" icon={Trash2} onClick={remove}>Delete</Button>}
            <Button variant="ghost" icon={ChevronLeft} onClick={() => navigate('/stakeholder/legal')}>Cancel</Button>
            <Button icon={Save} loading={busy} onClick={save}>{id ? 'Save' : 'Log legal issue'}</Button>
          </div>
        }
      />

      <div className="space-y-4">
        <section className="card space-y-4 p-5">
          <Field label="Title *" htmlFor="ltitle">
            <Input id="ltitle" value={form.title} onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Fire NOC inspection — show cause notice" />
          </Field>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">Site scope</div>
            <SiteScopePicker sites={sites} value={form.scope} onChange={(scope) => patch({ scope })} module="stakeholder" />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* The join, stored only here — see linkage.js. */}
            <Field label="Connected customer escalation" htmlFor="lesc" hint="Leave blank if this did not come from a complaint">
              <Select id="lesc" value={form.escalationId} onChange={(e) => patch({ escalationId: e.target.value })}>
                <option value="">Not linked to a complaint</option>
                {escalationOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
            <Field label="Date of incident / visit" htmlFor="ldate">
              <Input id="ldate" type="date" value={form.incidentDate} onChange={(e) => patch({ incidentDate: e.target.value })} />
            </Field>
          </div>

          <Field label="Description of the incident" htmlFor="ldesc">
            <Textarea id="ldesc" rows={5} value={form.description} onChange={(e) => patch({ description: e.target.value })}
              placeholder="What happened, what the officials asked for, what was shown to them." />
          </Field>
        </section>

        <section className="card p-5">
          <h2 className="mb-1 text-sm font-bold text-ink-800">Department(s) visited *</h2>
          <p className="mb-3 text-xs text-ink-500">
            Grouped by what they regulate. Pick as many as attended.
          </p>
          <div className="space-y-3">
            {DEPARTMENT_GROUPS.map((group) => (
              <div key={group}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{group}</div>
                <div className="flex flex-wrap gap-1.5">
                  {DEPARTMENTS.filter((d) => d.group === group).map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => toggleDept(d.key)}
                      className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                        form.departments.includes(d.key) ? 'bg-magenta-500 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {form.departments.includes('other') && (
            <Field className="mt-4" label="Name the other department *" htmlFor="ldeptother">
              <Input id="ldeptother" value={form.departmentOther} onChange={(e) => patch({ departmentOther: e.target.value })} />
            </Field>
          )}

          <Field className="mt-4" label="Officials who attended" htmlFor="lofficials" hint="Names / designations, if noted">
            <Input id="lofficials" value={form.officials} onChange={(e) => patch({ officials: e.target.value })} />
          </Field>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-sm font-bold text-ink-800">Notice served</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Type" htmlFor="lntype">
              <Select id="lntype" value={form.noticeType} onChange={(e) => patch({ noticeType: e.target.value })}>
                {NOTICE_TYPES.map((n) => <option key={n.key} value={n.key}>{n.label}</option>)}
              </Select>
            </Field>
            <Field label="Reference no." htmlFor="lnref">
              <Input id="lnref" value={form.noticeRef} onChange={(e) => patch({ noticeRef: e.target.value })} placeholder="FIR / notice number" />
            </Field>
            <Field label="Date served" htmlFor="lndate">
              <Input id="lndate" type="date" value={form.noticeDate} onChange={(e) => patch({ noticeDate: e.target.value })} />
            </Field>
          </div>

          {severe && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>This notice has a clock on it — set the response due date so it is not missed.</span>
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Response due" htmlFor="lndue">
              <Input id="lndue" type="date" value={form.responseDueDate} onChange={(e) => patch({ responseDueDate: e.target.value })} />
            </Field>
            <Field label="Penalty / fine (₹)" htmlFor="lpen">
              <Input id="lpen" type="number" min="0" value={form.penaltyAmount} onChange={(e) => patch({ penaltyAmount: e.target.value })} />
            </Field>
            <Field label="Status" htmlFor="lstat">
              <Select id="lstat" value={form.status} onChange={(e) => patch({ status: e.target.value })}>
                {LEGAL_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </Field>
          </div>
        </section>

        <section className="card p-5">
          <Field label="Owner" htmlFor="lowner" hint="Who is accountable for this matter">
            <Input id="lowner" className="max-w-sm" value={form.owner} onChange={(e) => patch({ owner: e.target.value })} />
          </Field>
        </section>

        <section className="card p-5">
          <CapaEditor value={form.capa || []} onChange={(capa) => patch({ capa })} />
        </section>

        <div className="flex justify-end gap-2 pb-2">
          <Button variant="ghost" onClick={() => navigate('/stakeholder/legal')}>Cancel</Button>
          <Button icon={Save} loading={busy} onClick={save}>{id ? 'Save' : 'Log legal issue'}</Button>
        </div>
      </div>
    </>
  )
}
