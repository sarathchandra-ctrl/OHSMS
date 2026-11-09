import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useReactToPrint } from 'react-to-print'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { Activity, Check, ChevronLeft, Save, Loader2, Printer, ListChecks, CheckCircle2 } from 'lucide-react'
import { PageHeader, Spinner } from '../components/ui'
import StepIllnessInitial from '../components/wizard/StepIllnessInitial'
import ActionEditor from '../components/ActionEditor'
import IllnessReportDoc from '../components/IllnessReportDoc'
import { useAuth } from '../context/AuthContext'
import { useIncidents } from '../context/IncidentContext'
import { isFutureDate } from '../../../shared/lib/dates'
import {
  createIllness, updateIllness, getIllness, closeIllness,
  subscribeIllnessFiles, addIllnessFile, deleteIllnessFile,
} from '../lib/illnesses'

const STEPS = ['initial', 'actions']
const LABEL = { initial: 'Initial Reporting', actions: 'Corrective Actions' }

export default function IllnessWizard() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { user, profile } = useAuth()
  const { users, incidents, org, sites } = useIncidents()
  const actor = useMemo(() => ({ uid: user?.uid, name: profile?.name || '' }), [user, profile])

  const [illness, setIllness] = useState(null)
  const [loading, setLoading] = useState(Boolean(id))
  const [saving, setSaving] = useState(false)
  const [files, setFiles] = useState([])

  const [draft, setDraft] = useState({
    linkedIncidentId: null, affectedPersonnel: [], date: '', time: '', location: '',
    region: '', entity: '', siteId: '', site: '',
    exposedToAgent: '', exposureDuration: '', ppe: [], healthIssue: '', affectedBodyParts: [],
  })
  const [actions, setActions] = useState([])

  useEffect(() => {
    if ((!id)) return
    let live = true
    getIllness(id).then((ill) => {
      if (!live || !ill) return
      setIllness(ill)
      setDraft({
        linkedIncidentId: ill.linkedIncidentId || null, affectedPersonnel: ill.affectedPersonnel || [],
        date: ill.date || '', time: ill.time || '', location: ill.location || '',
        region: ill.region || '', entity: ill.entity || '', siteId: ill.siteId || '', site: ill.site || '',
        exposedToAgent: ill.exposedToAgent || '', exposureDuration: ill.exposureDuration || '',
        ppe: ill.ppe || [], healthIssue: ill.healthIssue || '', affectedBodyParts: ill.affectedBodyParts || [],
      })
      setActions(ill.actions || [])
      setLoading(false)
    })
    const unsub = subscribeIllnessFiles(id, setFiles)
    return () => { live = false; unsub() }
  }, [id])

  const step = params.get('step') && STEPS.includes(params.get('step')) ? params.get('step') : 'initial'
  const goStep = (s) => setParams({ step: s })

  const addFile = async (f) => {
    if (!illness) return
    try { await addIllnessFile(illness.id, { ...f, uploadedBy: actor.name }) }
    catch (e) { toastCaught(e, 'File upload failed') }
  }
  const removeFile = async (fid) => {
    if (!illness) return
    try { await deleteIllnessFile(illness.id, fid) }
    catch (e) { toastCaught(e, 'File removal failed') }
  }

  const saveInitial = async () => {
    if (!draft.exposedToAgent) return toast.error('Select the agent exposed to')
    // A recorded illness has already been identified; a future date is a typo
    // or a wrong device clock, and it reaches the register and the exports as
    // a real case on a day that has not happened.
    if (isFutureDate(draft.date)) return toast.error('The illness date cannot be in the future')
    if ((draft.affectedPersonnel || []).length === 0) return toast.error('Add at least one affected person')
    setSaving(true)
    try {
      if (!illness) {
        const newId = await createIllness(actor, { ...draft })
        await updateIllness(newId, { 'stagesDone.initial': true }, { silent: true })
        toast.success('Illness report created')
        navigate(`/incidents/illness/${newId}?step=actions`, { replace: true })
      } else {
        await updateIllness(illness.id, { ...draft, 'stagesDone.initial': true }, { actor, summary: 'Updated illness report' })
        setIllness(await getIllness(illness.id))
        toast.success('Saved')
        goStep('actions')
      }
    } catch (e) {
      toastCaught(e, 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const saveActions = async (alsoClose) => {
    setSaving(true)
    try {
      await updateIllness(illness.id, { actions, 'stagesDone.actions': true, lifecycle: 'actions' }, { actor, summary: 'Updated corrective actions' })
      if (alsoClose) {
        await closeIllness(illness.id, actor)
        toast.success('Illness report closed')
        navigate('/incidents/illness')
        return
      }
      setIllness(await getIllness(illness.id))
      toast.success('Saved')
    } catch (e) {
      toastCaught(e, 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const printRef = useRef(null)
  const handlePrint = useReactToPrint({ content: () => printRef.current, documentTitle: illness ? `${illness.refNo}-illness-report` : 'illness-report' })

  if (loading) return <div className="grid h-64 place-items-center"><Spinner size={28} className="text-brand-500" /></div>

  return (
    <div>
      <PageHeader title={illness ? `Illness ${illness.refNo}` : 'Report Illness'} subtitle="Occupational illness reporting" icon={Activity}>
        {illness && <button className="btn-ghost" onClick={handlePrint}><Printer size={16} /> Print Report</button>}
      </PageHeader>

      <div className="card mb-6 flex gap-1 p-2">
        {STEPS.map((s, i) => {
          const done = illness?.stagesDone?.[s]
          const active = s === step
          return (
            <button key={s} onClick={() => illness && goStep(s)} disabled={!illness && s !== 'initial'}
              className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition disabled:opacity-40 ${active ? 'bg-brand-500 text-white shadow-elev-brand' : done ? 'bg-brand-50 text-brand-700' : 'text-ink-500 hover:bg-surface-100'}`}>
              <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${active ? 'bg-white/25' : done ? 'bg-brand-500 text-white' : 'bg-surface-200 text-ink-500'}`}>{done && !active ? <Check size={12} /> : i + 1}</span>
              {LABEL[s]}
            </button>
          )
        })}
      </div>

      <motion.div key={step} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        {step === 'initial' && (
          <StepIllnessInitial value={draft} onChange={setDraft} users={users} incidents={incidents} sites={sites} files={files} onAddFile={addFile} onRemoveFile={removeFile} canEdit={Boolean(illness)} />
        )}
        {step === 'actions' && (
          <div className="card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-500/10 text-brand-600"><ListChecks size={18} /></div>
              <div>
                <h3 className="font-bold text-ink-900">Corrective Actions</h3>
                <p className="text-xs text-ink-400">Assign owners & due dates — these feed the Action Tracker.</p>
              </div>
            </div>
            <ActionEditor value={actions} onChange={setActions} users={users} />
          </div>
        )}
      </motion.div>

      <div className="mt-6 flex items-center justify-between">
        <button className="btn-ghost" disabled={step === 'initial'} onClick={() => goStep('initial')}><ChevronLeft size={16} /> Back</button>
        <div className="flex gap-2">
          {step === 'initial' && (
            <button className="btn-primary" onClick={saveInitial} disabled={saving}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {illness ? 'Save & continue' : 'Create report'}</button>
          )}
          {step === 'actions' && (
            <>
              <button className="btn-ghost" onClick={() => saveActions(false)} disabled={saving}><Save size={16} /> Save</button>
              <button className="btn-primary" onClick={() => saveActions(true)} disabled={saving}>{saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Save & Close</button>
            </>
          )}
        </div>
      </div>

      <div className="hidden"><IllnessReportDoc ref={printRef} illness={illness ? { ...illness, actions } : null} org={org} /></div>
    </div>
  )
}
