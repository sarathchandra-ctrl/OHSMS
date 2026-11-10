import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { QRCodeCanvas } from 'qrcode.react'
import { PlusCircle, CheckCircle2, RotateCcw, Printer, Hash } from 'lucide-react'
import toast from 'react-hot-toast'
import { toastCaught } from '../../../shared/lib/toastCaught'
import { PageHeader, Spinner, Field } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useFleet } from '../context/FleetContext'
import { addExtinguisher } from '../lib/data'
import { nextSerial } from '../lib/serial'
import { TYPES, CAPACITIES } from '../lib/constants'
import { publicQrUrl, tokenFromQrValue } from '../lib/qr'
import { adoptionBlock } from '../lib/recycle'
import SiteScopePicker from '../../../shared/org/SiteScopePicker'

const EMPTY = {
  serialNo: '',
  type: 'ABC',
  capacity: '5 Kg',
  region: '',
  entity: '',
  siteId: '',
  site: '',
  centerName: '',
  dateOfDeployment: '',
  dateOfNextRefill: '',
  dateOfNextHPT: '',
  qrLink: '',
}

export default function AddExtinguisher() {
  const { orgName, profile } = useAuth()
  const { extinguishers, deletedExtinguishers, siteInventory } = useFleet()
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(null) // { id, qrToken, serialNo }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!form.site) return toast.error('Site is required')
    setBusy(true)
    try {
      // Serial No is optional — auto-assign a unique FE-#### when left blank.
      // The bin still holds its serials, so the next number has to see them or
      // a new unit is handed the code of one that can still be restored.
      const taken = [...extinguishers, ...(deletedExtinguishers || [])]
      const serialNo = form.serialNo.trim() || nextSerial(taken.map((x) => x.serialNo))
      const block = adoptionBlock({
        serial: serialNo,
        token: tokenFromQrValue(form.qrLink),
        live: extinguishers,
        deleted: deletedExtinguishers || [],
      })
      if (block) {
        toast.error(block)
        return
      }
      const payload = { ...form, serialNo }
      const res = await addExtinguisher(orgName, payload, { uid: profile?.uid, name: profile?.name })
      setCreated({ ...res, serialNo })
      toast.success('Extinguisher added with QR code!')
    } catch (err) {
      toastCaught(err)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setCreated(null)
    setForm(EMPTY)
  }

  return (
    <div>
      <PageHeader
        title="Add Extinguisher"
        subtitle="Register a single extinguisher. A public QR code is generated automatically."
        icon={PlusCircle}
      />

      <AnimatePresence mode="wait">
        {created ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="card mx-auto max-w-lg p-8 text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 18 }}
              className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-green-100 text-green-600"
            >
              <CheckCircle2 size={34} />
            </motion.div>
            <h2 className="text-xl font-extrabold text-ink-900">Extinguisher added</h2>
            <p className="mt-1 text-sm text-ink-500">
              {created.serialNo ? `Serial ${created.serialNo}` : 'New unit'} is now tracked. Scan or
              print its QR code below.
            </p>

            <div className="mx-auto mt-6 w-fit rounded-3xl bg-surface p-4 shadow-elev">
              <QRCodeCanvas value={publicQrUrl(created.qrToken)} size={176} level="M" includeMargin />
            </div>
            <p className="mt-2 break-all text-xs text-ink-400">{publicQrUrl(created.qrToken)}</p>

            <div className="mt-6 flex justify-center gap-3">
              <button className="btn-primary" onClick={reset}>
                <RotateCcw size={16} /> Add another
              </button>
              <a className="btn-ghost" href="/equipment/qr-print">
                <Printer size={16} /> Print QR codes
              </a>
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            onSubmit={onSubmit}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="grid gap-6 lg:grid-cols-3"
          >
            <div className="card space-y-4 p-6 lg:col-span-2">
              <h3 className="text-sm font-bold uppercase tracking-wide text-ink-500">Specification</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Serial No (optional — auto FE-#### if blank)">
                  <div className="relative">
                    <Hash size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                    <input className="input pl-9" placeholder="Auto-assigned if left blank" value={form.serialNo} onChange={set('serialNo')} />
                  </div>
                </Field>
                <Field label="Type">
                  <select className="input" value={form.type} onChange={set('type')}>
                    {TYPES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </Field>
                <Field label="Capacity">
                  <select className="input" value={form.capacity} onChange={set('capacity')}>
                    {CAPACITIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Site — Region · Entity · Site" className="sm:col-span-2">
                  <SiteScopePicker
                    module="equipment"
                    sites={siteInventory}
                    value={form}
                    onChange={(v) => setForm((f) => ({ ...f, ...v, centerName: v.site }))}
                  />
                </Field>
              </div>

              <h3 className="pt-2 text-sm font-bold uppercase tracking-wide text-ink-500">Compliance dates</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Date of Deployment">
                  <input type="date" className="input" value={form.dateOfDeployment} onChange={set('dateOfDeployment')} />
                </Field>
                <Field label="Date of Next Refill">
                  <input type="date" className="input" value={form.dateOfNextRefill} onChange={set('dateOfNextRefill')} />
                </Field>
                <Field label="Date of Next HPT">
                  <input type="date" className="input" value={form.dateOfNextHPT} onChange={set('dateOfNextHPT')} />
                </Field>
                {/* Stock often arrives with labels already stuck on. Minting a
                    fresh token regardless would leave every printed label
                    scanning to nothing, so an existing code can be adopted —
                    the same field the CSV import has always accepted. */}
                <Field label="QR Link (optional — adopt a label already printed)">
                  <input
                    className="input"
                    placeholder="https://.../qr/AB12CD34 — leave blank to generate a new code"
                    value={form.qrLink}
                    onChange={set('qrLink')}
                  />
                </Field>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" className="btn-ghost" onClick={() => setForm(EMPTY)}>Clear</button>
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy ? <Spinner size={18} /> : (<><PlusCircle size={16} /> Add extinguisher</>)}
                </button>
              </div>
            </div>

            {/* Live summary card */}
            <div className="card h-fit space-y-4 bg-gradient-to-br from-ink-950 to-ink-900 p-6 text-white">
              <div className="flex items-center gap-2 text-sm font-bold text-white/70">
                <span className="text-lg">🔥</span> Live preview
              </div>
              <div className="rounded-xl bg-white/5 p-4">
                <p className="text-3xl font-black">{form.type}</p>
                <p className="text-white/60">{form.capacity} · {form.entity}</p>
              </div>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-white/50">Serial</dt><dd className="font-semibold">{form.serialNo || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-white/50">Region</dt><dd className="font-semibold">{form.region || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-white/50">Site</dt><dd className="font-semibold">{form.site || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-white/50">Next refill</dt><dd className="font-semibold">{form.dateOfNextRefill || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-white/50">Next HPT</dt><dd className="font-semibold">{form.dateOfNextHPT || '—'}</dd></div>
              </dl>
              <p className="text-xs text-white/40">A unique public QR code is generated on save.</p>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  )
}
