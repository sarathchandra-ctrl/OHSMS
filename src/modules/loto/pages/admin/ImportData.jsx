import { useState } from 'react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../../shared/lib/toastCaught'
import { useAuth } from '../../context/AuthContext'
import { useAuth as useAppAuth } from '../../../../shared/auth/AuthContext'
import { IMPORT_KINDS, importRows, templateCsv } from '../../utils/csvImport'
import { addLock } from '../../services/locks'
import { addGroupNumber } from '../../services/groupNumbers'
import { addTechnician } from '../../services/technicians'
import { createProcedure, newProcedureId } from '../../services/procedures'
import PageHeader, { HdrIcon } from '../../components/PageHeader'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'

async function applyRow(kind, row, { user }) {
  if (kind === 'locks') await addLock({ lockNo: row.lockNo, tagNo: row.tagNo, color: row.color, type: 'department' }, user)
  else if (kind === 'groups') await addGroupNumber({ no: row.no, description: row.description })
  else if (kind === 'technicians') await addTechnician({ ...row }, user)
  else {
    const id = newProcedureId()
    await createProcedure(id, {
      equipment: row.equipment,
      site: row.site,
      isolationPoints: [{
        key: 'k1',
        energySource: row.energy || 'electrical',
        devices: ['safety_padlock'],
      }],
    }, user)
  }
}

export default function ImportData() {
  const { profile, platformRole } = useAuth()
  const { isManager } = useAppAuth()
  const [kind, setKind] = useState('locks')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)

  function downloadTemplate() {
    const blob = new Blob([templateCsv(kind)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `permit_${kind}_template.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function onImport() {
    const { rows, errors } = importRows(kind, text)
    if (errors.length) {
      setReport({ added: 0, errors })
      return
    }
    if (kind === 'groups' && platformRole !== 'admin') {
      toast.error('Only an Admin can import group numbers')
      return
    }
    // The server refuses technicians from anyone but a manager (stack/policy.mjs).
    if (kind === 'technicians' && !isManager) {
      toast.error('Only a manager can import technicians')
      return
    }
    setBusy(true)
    const failed = []
    let added = 0
    for (const row of rows) {
      try {
        await applyRow(kind, row, { user: profile })
        added += 1
      } catch (err) {
        failed.push(err?.message || 'Could not import a row')
      }
    }
    setBusy(false)
    setReport({ added, errors: failed })
    if (added) toast.success(`Imported ${added}`)
    if (failed.length) toastCaught(new Error(failed[0]), 'Some rows were not imported')
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        icon={<HdrIcon d={<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>} />}
        title="Import"
        subtitle="Templates for equipment, locks, group numbers and technicians. Examples are invented."
      />
      <Card animate={false} className="mt-4 space-y-3 !p-5">
        <label className="block text-sm text-steel-200" htmlFor="imp-kind">What to import</label>
        <select id="imp-kind" className="input w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(IMPORT_KINDS).map(([key, spec]) => (
            <option key={key} value={key}>{spec.label}</option>
          ))}
        </select>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="steel" onClick={downloadTemplate}>Download template</Button>
        </div>
        <label className="block text-sm text-steel-200" htmlFor="imp-csv">CSV</label>
        <textarea
          id="imp-csv"
          className="input min-h-40 w-full font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={templateCsv(kind)}
        />
        <Button type="button" loading={busy} onClick={onImport}>Import</Button>
        {report && (
          <p role="status" className="text-sm text-steel-200">
            {report.added} added. {report.errors.length ? report.errors.join(' ') : 'No problems.'}
          </p>
        )}
      </Card>
    </div>
  )
}
