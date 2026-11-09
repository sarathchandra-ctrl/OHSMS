import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, MessageCircle, Send, Share2 } from 'lucide-react'
import { AUDIT } from '../../shared/audit/audit'
import {
  addWhatsAppOrgNumber,
  removeWhatsAppOrgNumber,
  sendWhatsAppOrgTest,
  setWhatsAppOrgEnabled,
  whatsAppOrgStatus,
} from '../../shared/functions'
import { logAudit, subscribeOrgUsers } from '../../shared/org/orgData'
import { Badge, Button, Card, Field, Input, Select } from '../../shared/ui'
import { safeWaChatLink } from './whatsappConnectApi.js'

/**
 * Org Settings → Integrations → Connect with WhatsApp.
 *
 * The shared business number is one for the deployment. This screen lets an
 * organisation administrator see whether it is switched on, turn lookup on or
 * off for their own organisation, and name which employees' handsets may ask
 * about that organisation's sites. Every one of those actions is a callable.
 * The access token, the app secret and the verify token are not parameters
 * of those callables and are not rendered here.
 */
export default function WhatsAppConnect({ actor }) {
  const [status, setStatus] = useState(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [members, setMembers] = useState([])
  const [phone, setPhone] = useState('')
  const [memberUid, setMemberUid] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [testError, setTestError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const next = await whatsAppOrgStatus()
    setStatus(next)
    setFailed(false)
    setTestPhone((current) => {
      if (current && next.links?.some((l) => l.phone === current)) return current
      return next.links?.[0]?.phone || ''
    })
    return next
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const next = await whatsAppOrgStatus()
        if (cancelled) return
        setStatus(next)
        setTestPhone(next.links?.[0]?.phone || '')
        setFailed(false)
      } catch {
        if (!cancelled) setFailed(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return subscribeOrgUsers(setMembers)
  }, [])

  const employees = useMemo(
    () =>
      (members || [])
        .filter((m) => m.status === 'approved' && m.mustChangePassword !== true)
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [members]
  )
  const byUid = useMemo(() => new Map(employees.map((m) => [m.uid, m])), [employees])

  const audit = (summary) =>
    logAudit(actor, AUDIT.ORG_SETTINGS, {
      module: 'core',
      target: 'whatsapp',
      targetLabel: 'WhatsApp',
      summary,
    })

  const run = async (fn) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error(err?.message || 'That did not work')
    } finally {
      setBusy(false)
    }
  }

  const chatLink = safeWaChatLink(status?.chatLink)
  const enabled = status?.enabled !== false

  const toggle = () =>
    run(async () => {
      const next = !enabled
      await setWhatsAppOrgEnabled(next)
      await audit(
        next
          ? 'Turned WhatsApp site lookup on for this organisation'
          : 'Turned WhatsApp site lookup off for this organisation'
      )
      toast.success(next ? 'WhatsApp lookup is on' : 'WhatsApp lookup is off')
      await refresh()
    })

  const add = (e) => {
    e.preventDefault()
    run(async () => {
      const out = await addWhatsAppOrgNumber({ phone, uid: memberUid || null })
      const person = byUid.get(out.uid)
      const who = person?.name || 'an employee'
      await audit(`Linked a WhatsApp number (${out.masked}) to ${who}`)
      toast.success(`Linked ${out.masked} to ${who}`)
      setPhone('')
      await refresh()
    })
  }

  const remove = (row) =>
    run(async () => {
      const out = await removeWhatsAppOrgNumber(row.phone)
      await audit(`Removed a WhatsApp number (${out.masked || row.masked})`)
      toast.success(`Removed ${out.masked || row.masked}`)
      await refresh()
    })

  const sendTest = () =>
    run(async () => {
      setTestError('')
      try {
        const out = await sendWhatsAppOrgTest(testPhone)
        await audit(`Sent a WhatsApp test message to ${out.masked}`)
        toast.success(`Test sent to ${out.masked}`)
      } catch (err) {
        const message = err?.message || 'The test message could not be sent.'
        // 131047 usually arrives later, on the status webhook, so the note
        // below is the part an admin can always see. A synchronous refusal
        // stays on the page as well as in the toast.
        if (/131047|24 hours/i.test(message)) setTestError(message)
        throw err
      }
    })

  return (
    <div className="max-w-2xl space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3
              id="wa-connect-heading"
              className="flex items-center gap-2 font-semibold text-ink-800"
            >
              <MessageCircle size={17} className="text-brand-600" aria-hidden="true" />
              Connect with WhatsApp
            </h3>
            <p className="mt-1 max-w-[62ch] text-sm text-ink-500">
              The shared WeEHS WhatsApp number answers site lookups for this organisation when an
              administrator has turned it on, and only for the handsets listed below. Each handset
              sees the sites that employee can already open in the app.
            </p>
          </div>
          {status && (
            <Badge tone={enabled ? 'green' : 'amber'}>
              {enabled ? 'On for this organisation' : 'Off'}
            </Badge>
          )}
        </div>

        {loading && <p className="mt-4 text-sm text-ink-500">Checking the WhatsApp connection…</p>}

        {failed && !loading && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-ink-600">Could not load WhatsApp settings.</p>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                run(async () => {
                  setLoading(true)
                  try {
                    await refresh()
                  } finally {
                    setLoading(false)
                  }
                })
              }
            >
              Try again
            </Button>
          </div>
        )}

        {status && (
          <div className="mt-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink-50 px-3 py-3">
              <div>
                <p className="text-sm font-medium text-ink-800">
                  {status.platformReady
                    ? 'The shared number is switched on'
                    : 'The shared number is not switched on yet'}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {status.platformReady
                    ? 'Messages are answered when this organisation has lookup turned on.'
                    : 'An operator still has to switch the shared number on. You can prepare the list below in the meantime.'}
                </p>
              </div>
              <Button
                type="button"
                variant={enabled ? 'ghost' : 'primary'}
                onClick={toggle}
                disabled={busy}
              >
                {enabled ? 'Turn off for this organisation' : 'Turn on for this organisation'}
              </Button>
            </div>

            {chatLink ? (
              <ChatShare
                url={chatLink}
                caption={status.number ? `Message ${status.number}` : 'Open the WhatsApp chat'}
                qrLabel="QR code that opens a WhatsApp chat with the site lookup number"
                copyLabel="Copy WhatsApp link"
                shareLabel="Share WhatsApp link"
              />
            ) : (
              <p className="text-sm text-ink-500">
                The shared number is not published yet, so there is no chat link to copy.
              </p>
            )}

            <form onSubmit={add} className="space-y-3">
              <h4 className="text-sm font-semibold text-ink-800">Allowed numbers</h4>
              <p className="text-xs leading-relaxed text-ink-500">
                Add the WhatsApp number that may ask about this organisation&apos;s sites, and the
                employee it belongs to. Include the country code, the way WhatsApp sends it — for
                example 919000000001. If you leave the employee blank and exactly one approved
                profile already has this number, it is matched. The employee can disconnect it by
                sending UNLINK.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="WhatsApp number"
                  hint="Country code, then the number. No spaces required."
                >
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="919000000001"
                    required
                  />
                </Field>
                <Field
                  label="Employee"
                  hint="Leave blank to match a profile that already has this number."
                >
                  <Select value={memberUid} onChange={(e) => setMemberUid(e.target.value)}>
                    <option value="">Match from the employee profile</option>
                    {employees.map((m) => (
                      <option key={m.uid} value={m.uid}>
                        {m.name || m.email || m.uid}
                        {m.email ? ` — ${m.email}` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button type="submit" disabled={busy}>
                Add number
              </Button>
            </form>

            {status.truncated && (
              <p className="text-xs text-ink-500">
                Showing the first {status.links?.length || 0} numbers.
              </p>
            )}

            {status.links?.length ? (
              <ul className="space-y-2">
                {status.links.map((row) => {
                  const person = row.uid ? byUid.get(row.uid) : null
                  const name =
                    person?.name || (row.uid ? 'Not in the employee list' : 'No employee mapped')
                  return (
                    <li
                      key={row.phone}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface-50/60 px-3 py-2.5 ring-1 ring-ink-200"
                    >
                      <div>
                        <p className="font-mono text-sm text-ink-800">{row.phone}</p>
                        <p className="text-xs text-ink-500">
                          {name}
                          {person?.email ? ` · ${person.email}` : ''}
                          {' · '}
                          {row.source === 'admin'
                            ? 'Added by an administrator'
                            : 'Linked from the app'}
                          {row.active
                            ? ''
                            : ' · not an approved member, so the bot will not answer'}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="px-2 py-1"
                        disabled={busy}
                        onClick={() => remove(row)}
                      >
                        Remove <span className="sr-only">{row.masked}</span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-sm text-ink-500">
                No WhatsApp numbers are linked to this organisation yet.
              </p>
            )}

            <div className="space-y-3 border-t border-ink-100 pt-4">
              <h4 className="text-sm font-semibold text-ink-800">Test message</h4>
              <p className="text-xs leading-relaxed text-ink-500">
                Sends one short message to a number already on the list above. It does not include
                site details. It is refused when the shared number is not switched on.
              </p>
              <p className="text-xs leading-relaxed text-ink-500">
                A free-form test is delivered only if that handset has messaged the shared number in
                the last 24 hours. If it has not, WhatsApp rejects it. Ask them to send any message
                to the number, then try again.
              </p>
              {testError ? (
                <p role="alert" className="text-sm font-medium text-red-400">
                  {testError}
                </p>
              ) : null}
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Send the test to" className="min-w-[16rem] flex-1">
                  <Select
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value)}
                    disabled={!status.links?.length}
                  >
                    {!status.links?.length && <option value="">No linked number</option>}
                    {(status.links || []).map((row) => {
                      const person = row.uid ? byUid.get(row.uid) : null
                      return (
                        <option key={row.phone} value={row.phone}>
                          {row.masked}
                          {person?.name ? ` — ${person.name}` : ''}
                        </option>
                      )
                    })}
                  </Select>
                </Field>
                <Button
                  type="button"
                  icon={Send}
                  variant="soft"
                  disabled={busy || !status.platformReady || !testPhone}
                  onClick={sendTest}
                >
                  Send test message
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function ChatShare({ url, caption, qrLabel, copyLabel, shareLabel }) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      toast.success('Link copied')
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  const share = async () => {
    try {
      await navigator.share({ title: caption, url })
    } catch (err) {
      if (err?.name === 'AbortError') return
      await copy()
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="rounded-xl bg-white p-3 shadow-elev-sm" role="img" aria-label={qrLabel}>
        <QRCodeSVG value={url} size={148} level="M" includeMargin aria-hidden="true" />
      </div>
      <div className="min-w-[16rem] flex-1 space-y-2">
        <p className="text-sm text-ink-700">{caption}</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block break-all text-sm font-medium text-brand-700 underline"
        >
          {url}
        </a>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            className="px-2 py-1"
            icon={copied ? Check : Copy}
            onClick={copy}
          >
            {copied ? 'Copied' : copyLabel}
          </Button>
          {canShare && (
            <Button
              type="button"
              variant="ghost"
              className="px-2 py-1"
              icon={Share2}
              onClick={share}
            >
              {shareLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
