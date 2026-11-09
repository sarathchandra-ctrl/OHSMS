import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { ChevronLeft, Save, UserPlus, X, Trash2 } from 'lucide-react'
import {
  PageHeader, Button, Field, Input, Select, Textarea, SkeletonDetail, EmptyState, AccessDenied,
} from '../../../shared/ui'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'
import { useAuth } from '../../../shared/auth/AuthContext'
import { useStakeholder } from '../context/StakeholderContext'
import { addEscalation, updateEscalation, deleteEscalation } from '../lib/firestore'
import { ESCALATION_STATUS, ESCALATION_CHANNEL, SEVERITY } from '../lib/constants'
import AttachmentField from '../components/AttachmentField'
import CapaEditor from '../components/CapaEditor'

const EMPTY = {
  title: '', scope: {}, channel: 'in_person', severity: 'medium', status: 'open',
  raisedOn: '', description: '', members: [],
  legalNoticeReceived: false, legalNoticeRef: '', legalNoticeDate: '',
  owner: '',
  attachments: { cctv: [], ethics: [] },
  capa: [],
}
const EMPTY_MEMBER = { memberId: '', name: '', contact: '', note: '' }

/**
 * A full page rather than a modal.
 *
 * An escalation carries a site scope, a free-text account, an unbounded list of
 * members and a closing action — that is a form somebody works through with the
 * complainant on the phone, not a dialog they dismiss. In a modal the member
 * rows push everything else out of view and the page behind is unreachable, so
 * this follows the incident wizard: its own route, so it survives a refresh and
 * can be linked to.
 */
export default function EscalationForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { actor, isManager } = useAuth()
  const { escalations, sites, loading } = useStakeholder()

  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // Wait for the live list before deciding a record is missing — on a cold load
  // it is simply not there yet, and redirecting would bounce anyone who opened
  // an edit link directly.
  useEffect(() => {
    if (!id || hydrated || loading) return
    const found = escalations.find((e) => e.id === id)
    if (found) {
      setForm({ ...EMPTY, ...found, attachments: { ...EMPTY.attachments, ...(found.attachments || {}) } })
      setHydrated(true)
    }
  }, [id, escalations, loading, hydrated])

  const patch = (p) => setForm((f) => ({ ...f, ...p }))
  const addMember = () => patch({ members: [...(form.members || []), { ...EMPTY_MEMBER }] })
  const setMember = (i, p) => patch({ members: form.members.map((m, idx) => (idx === i ? { ...m, ...p } : m)) })
  const removeMember = (i) => patch({ members: form.members.filter((_, idx) => idx !== i) })

  const save = async () => {
    if (!form.title.trim()) return toast.error('Give the escalation a title')
    if (!(form.members || []).some((m) => m.memberId.trim() || m.name.trim())) {
      return toast.error('Add at least one member — who raised this?')
    }
    setBusy(true)
    try {
      if (id) await updateEscalation(id, form, actor)
      else await addEscalation(form, actor)
      toast.success(id ? 'Saved' : 'Escalation logged')
      navigate('/stakeholder/escalations')
    } catch (e) {
      toastCaught(e)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const linked = escalations.find((e) => e.id === id)?.legalCount || 0
    const warn = linked
      ? `Delete this escalation? ${linked} legal issue(s) point at it and will show as a broken link.`
      : 'Delete this escalation?'
    // eslint-disable-next-line no-alert
    if (!window.confirm(warn)) return
    try {
      await deleteEscalation(id, form.title, actor)
      toast.success('Deleted')
      navigate('/stakeholder/escalations')
    } catch (e) {
      toastCaught(e)
    }
  }

  if (!isManager) {
    return <AccessDenied description="Ask an admin or manager to log escalations." />
  }
  if (id && loading && !hydrated) return <SkeletonDetail />
  if (id && !loading && !hydrated) {
    return (
      <EmptyState
        title="Escalation not found"
        hint="It may have been deleted."
        action={<Button onClick={() => navigate('/stakeholder/escalations')}>Back to escalations</Button>}
      />
    )
  }

  return (
    <>
      <PageHeader
        title={id ? 'Edit escalation' : 'Log customer escalation'}
        subtitle={form.docId || undefined}
        actions={
          <div className="flex gap-2">
            {id && <Button variant="ghost" icon={Trash2} onClick={remove}>Delete</Button>}
            <Button variant="ghost" icon={ChevronLeft} onClick={() => navigate('/stakeholder/escalations')}>
              Cancel
            </Button>
            <Button icon={Save} loading={busy} onClick={save}>{id ? 'Save' : 'Log escalation'}</Button>
          </div>
        }
      />

      <div className="space-y-4">
        <section className="card space-y-4 p-5">
          <Field label="Title *" htmlFor="etitle">
            <Input id="etitle" value={form.title} onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Repeated equipment failure — refund demanded" />
          </Field>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">Site scope</div>
            <SiteScopePicker sites={sites} value={form.scope} onChange={(scope) => patch({ scope })} module="stakeholder" />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Raised on" htmlFor="eraised">
              <Input id="eraised" type="date" value={form.raisedOn} onChange={(e) => patch({ raisedOn: e.target.value })} />
            </Field>
            <Field label="Channel" htmlFor="echan">
              <Select id="echan" value={form.channel} onChange={(e) => patch({ channel: e.target.value })}>
                {ESCALATION_CHANNEL.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Select>
            </Field>
            <Field label="Severity" htmlFor="esev">
              <Select id="esev" value={form.severity} onChange={(e) => patch({ severity: e.target.value })}>
                {SEVERITY.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </Field>
            <Field label="Status" htmlFor="estat">
              <Select id="estat" value={form.status} onChange={(e) => patch({ status: e.target.value })}>
                {ESCALATION_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </Field>
          </div>

          <Field label="Description of the issue" htmlFor="edesc">
            <Textarea id="edesc" rows={5} value={form.description} onChange={(e) => patch({ description: e.target.value })}
              placeholder="What happened, in the customer's terms." />
          </Field>
        </section>

        {/* Its own section: one incident routinely involves several members, and
            recording only the loudest loses the repeat-complainant pattern. */}
        <section className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-ink-800">Members involved *</h2>
              <p className="text-xs text-ink-500">
                Add everyone who raised this — repeat complaints only surface if they are all recorded.
              </p>
            </div>
            <Button variant="ghost" icon={UserPlus} onClick={addMember}>Add member</Button>
          </div>

          {!(form.members || []).length ? (
            <p className="rounded-xl bg-ink-50 px-3 py-4 text-center text-sm text-ink-500">
              No members added yet.
            </p>
          ) : (
            <div className="space-y-2">
              {form.members.map((m, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 rounded-xl bg-ink-50 p-3 sm:grid-cols-[1fr_1.2fr_1fr_1.4fr_auto]">
                  <Input placeholder="Member ID" value={m.memberId} onChange={(e) => setMember(i, { memberId: e.target.value })} />
                  <Input placeholder="Name" value={m.name} onChange={(e) => setMember(i, { name: e.target.value })} />
                  <Input placeholder="Phone / email" value={m.contact} onChange={(e) => setMember(i, { contact: e.target.value })} />
                  <Input placeholder="Note" value={m.note} onChange={(e) => setMember(i, { note: e.target.value })} />
                  <Button variant="ghost" className="px-2 py-1" icon={X} onClick={() => removeMember(i)} />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* A customer can serve a notice directly, with no authority involved —
            that is a different thing from a regulatory matter. */}
        <section className="card p-5">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink-700">
            <input type="checkbox" checked={form.legalNoticeReceived}
              onChange={(e) => patch({ legalNoticeReceived: e.target.checked })} />
            A legal notice was received from the customer
          </label>
          {form.legalNoticeReceived && (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Notice reference" htmlFor="enref">
                <Input id="enref" value={form.legalNoticeRef} onChange={(e) => patch({ legalNoticeRef: e.target.value })} />
              </Field>
              <Field label="Notice date" htmlFor="endate">
                <Input id="endate" type="date" value={form.legalNoticeDate} onChange={(e) => patch({ legalNoticeDate: e.target.value })} />
              </Field>
            </div>
          )}
          <p className="mt-2 text-xs text-ink-500">
            If an authority became involved, record that as a Legal Issue and link it to this escalation.
          </p>
        </section>

        {/* Evidence. Kept out of the description because a dispute is settled
            by what can be produced, not by what was written down. */}
        <section className="card space-y-5 p-5">
          <h2 className="text-sm font-bold text-ink-800">Evidence</h2>
          <AttachmentField
            kind="cctv"
           
            actor={actor}
            value={form.attachments?.cctv || []}
            onChange={(cctv) => patch({ attachments: { ...form.attachments, cctv } })}
          />
          <AttachmentField
            kind="ethics"
           
            actor={actor}
            value={form.attachments?.ethics || []}
            onChange={(ethics) => patch({ attachments: { ...form.attachments, ethics } })}
          />
        </section>

        {/* Owner kept, the action narrative dropped: CAPA below records what
            was done, with an owner and a date per action rather than one
            paragraph for the whole complaint. */}
        <section className="card p-5">
          <Field label="Owner" htmlFor="eowner" hint="Who is accountable for this escalation">
            <Input id="eowner" className="max-w-sm" value={form.owner} onChange={(e) => patch({ owner: e.target.value })} />
          </Field>
        </section>

        <section className="card p-5">
          <CapaEditor value={form.capa || []} onChange={(capa) => patch({ capa })} />
        </section>

        <div className="flex justify-end gap-2 pb-2">
          <Button variant="ghost" onClick={() => navigate('/stakeholder/escalations')}>Cancel</Button>
          <Button icon={Save} loading={busy} onClick={save}>{id ? 'Save' : 'Log escalation'}</Button>
        </div>
      </div>
    </>
  )
}
