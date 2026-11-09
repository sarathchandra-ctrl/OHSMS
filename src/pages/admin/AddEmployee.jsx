import { useState } from 'react'
import toast from 'react-hot-toast'
import { UserPlus, RefreshCw, Copy } from 'lucide-react'
import { Button, Field, Input, Select, Modal } from '../../shared/ui'
import { ROLES } from '../../shared/auth/permissions'
import { createMember } from '../../shared/functions'

const REASONS = {
  email: 'Enter a valid email address.',
  role: 'Choose a role.',
  policy: 'The temporary password needs at least 10 characters.',
  'already-member': 'Someone with that email is already an employee.',
  'not-admin': 'Only an administrator can add employees.',
}

/** A random temporary password: 14 characters, no look-alikes. */
export function temporaryPassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = new Uint32Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
  } catch {
    toast.error('Copy failed — select the text instead')
  }
}

/**
 * Add a person with a temporary password. They must replace it the first
 * time they sign in. The password is shown once here, for the admin to pass
 * on; the server keeps only its hash.
 */
export default function AddEmployee() {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', role: 'member', password: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  const start = () => {
    setForm({ name: '', email: '', role: 'member', password: temporaryPassword() })
    setDone(null)
    setOpen(true)
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await createMember(form)
      setDone({ email: form.email.trim().toLowerCase(), password: form.password })
      toast.success('Employee added')
    } catch (err) {
      toast.error(REASONS[err?.reason] || err?.message || 'The employee was not added.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button icon={UserPlus} onClick={start}>
        Add employee
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={done ? 'Employee added' : 'Add employee'}
        footer={
          done ? (
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button form="add-employee" type="submit" loading={busy}>
                Add
              </Button>
            </>
          )
        }
      >
        {done ? (
          <div className="space-y-3 text-sm text-ink-700">
            <p>
              Give these to <b>{done.email}</b>. They will be asked to choose their own password
              the first time they sign in. This password is not shown again.
            </p>
            <div className="well flex items-center justify-between gap-2 rounded-xl p-3 font-mono">
              <span>{done.password}</span>
              <Button variant="ghost" icon={Copy} type="button" onClick={() => copy(done.password)}>
                Copy
              </Button>
            </div>
          </div>
        ) : (
          <form id="add-employee" onSubmit={submit} className="space-y-4">
            <Field label="Full name" htmlFor="emp-name">
              <Input
                id="emp-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Work email" htmlFor="emp-email">
              <Input
                id="emp-email"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Role" htmlFor="emp-role">
              <Select
                id="emp-role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {ROLES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Temporary password"
              htmlFor="emp-password"
              hint="At least 10 characters. They change it at first sign-in."
            >
              <div className="flex gap-2">
                <Input
                  id="emp-password"
                  required
                  minLength={10}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="font-mono"
                />
                <Button
                  variant="ghost"
                  type="button"
                  icon={RefreshCw}
                  onClick={() => setForm({ ...form, password: temporaryPassword() })}
                >
                  New
                </Button>
              </div>
            </Field>
          </form>
        )}
      </Modal>
    </>
  )
}
