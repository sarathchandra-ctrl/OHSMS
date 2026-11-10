import { useState } from 'react'
import toast from 'react-hot-toast'
import { MessageCircle, Link2Off } from 'lucide-react'
import { useAuth } from '../../shared/auth/AuthContext'
import { logAudit } from '../../shared/org/orgData'
import { whatsAppLinkStatus, startWhatsAppLink, unlinkWhatsApp } from '../../shared/functions'
import { Button, Badge } from '../../shared/ui'
import { formatDate } from '../../shared/lib/format'

/**
 * Settings → Security → WhatsApp site lookup.
 *
 * The code is the proof of possession for the signed-in person: the app knows
 * who asked for it, and Meta tells the server which number sent it back.
 * Attaching a number to someone else is an administrator action and lives in
 * Org Settings → Integrations, not on this page.
 *
 * The notice below is the DPDP notice for this processing: what is kept, for
 * how long, who processes it (Meta), and how to withdraw.
 *
 * Status is fetched when asked for, not on mount. Most visits to this page are
 * about two-factor, and a callable on every render is a request per visit to
 * a function most people never use — and, where no functions backend is
 * running (the e2e emulator suite), a console error on a page that has none.
 */
export default function WhatsAppLink() {
  const { user, profile } = useAuth()
  const [status, setStatus] = useState(null)
  const [issued, setIssued] = useState(null) // { code, expiresAtMs, number }
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = async () => {
    try {
      setStatus(await whatsAppLinkStatus())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  const actor = { uid: user?.uid, name: profile?.name }

  const begin = async () => {
    setBusy(true)
    try {
      const out = await startWhatsAppLink()
      setIssued(out)
      await logAudit(actor, 'wa.link_code', {
        module: 'core',
        target: 'whatsapp',
        summary: 'Requested a WhatsApp link code',
      })
    } catch (err) {
      toast.error(err?.message || 'Could not create a code')
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    setBusy(true)
    try {
      await unlinkWhatsApp()
      await logAudit(actor, 'wa.unlink', {
        module: 'core',
        target: 'whatsapp',
        summary: 'Unlinked WhatsApp site lookup',
      })
      toast.success('WhatsApp unlinked')
      setIssued(null)
      await refresh()
    } catch (err) {
      toast.error(err?.message || 'Could not unlink')
    } finally {
      setBusy(false)
    }
  }

  // Off until the operator switches it on; say so rather than offering a button that fails.
  if (failed || (status && !status.available && !status.linked)) {
    return (
      <section className="card mt-4 max-w-2xl space-y-2 p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink-800">
          <MessageCircle size={14} /> WhatsApp site lookup
        </h2>
        <p className="text-xs text-ink-500">
          {failed
            ? 'Could not check WhatsApp linking right now.'
            : 'Not switched on for this system yet.'}
        </p>
      </section>
    )
  }
  if (!status) {
    return (
      <section className="card mt-4 max-w-2xl space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink-800">
          <MessageCircle size={14} /> WhatsApp site lookup
        </h2>
        <p className="max-w-[56ch] text-xs leading-relaxed text-ink-500">
          Get a site&apos;s safety summary on WhatsApp by sending its code, for sites you can
          already open in the app.
        </p>
        <Button
          variant="ghost"
          loading={busy}
          onClick={async () => {
            setBusy(true)
            await refresh()
            setBusy(false)
          }}
        >
          Set up or check WhatsApp
        </Button>
      </section>
    )
  }

  const minutes = issued ? Math.max(1, Math.round((issued.expiresAtMs - Date.now()) / 60000)) : 0

  return (
    <section className="card mt-4 max-w-2xl space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-ink-800">
            <MessageCircle size={14} /> WhatsApp site lookup
          </h2>
          <p className="mt-0.5 max-w-[56ch] text-xs leading-relaxed text-ink-500">
            Send a site code to the WhatsApp number and get that site&apos;s safety summary back —
            extinguishers, open defects, first aid boxes, pending actions, incidents and emergency
            contacts — for sites you can already open in the app.
          </p>
        </div>
        {status.linked ? (
          <Badge tone="green">Linked</Badge>
        ) : (
          <Badge tone="amber">Not linked</Badge>
        )}
      </div>

      {status.linked && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-50 px-3 py-2.5">
          <span className="text-sm text-ink-800">
            Linked to {status.masked}
            {status.linkedAt && (
              <span className="text-xs text-ink-500">
                {' '}
                · since {formatDate(status.linkedAt)}
              </span>
            )}
          </span>
          <Button
            variant="ghost"
            className="px-2 py-1"
            icon={Link2Off}
            onClick={unlink}
            disabled={busy}
          >
            Unlink
          </Button>
        </div>
      )}

      {issued ? (
        <div className="space-y-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
          <p>
            From the phone you want to link, send this message
            {issued.number ? (
              <>
                {' '}
                to <strong>{issued.number}</strong>
              </>
            ) : (
              ' to the WhatsApp lookup number'
            )}
            :
          </p>
          <p className="font-mono text-lg tracking-widest">LINK {issued.code}</p>
          <p className="text-xs">
            Single use. Expires in about {minutes} minute{minutes === 1 ? '' : 's'}.
          </p>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={refresh}>
            I&apos;ve sent it — refresh
          </Button>
        </div>
      ) : (
        status.available && (
          <Button onClick={begin} loading={busy}>
            {status.linked ? 'Link a different number' : 'Link WhatsApp'}
          </Button>
        )
      )}

      <p className="max-w-[64ch] text-[11px] leading-relaxed text-ink-500">
        What is kept: your WhatsApp number (until you unlink) and a log of which site you looked up
        and when (90 days). Message text is not stored. Messages pass through WhatsApp (Meta) as a
        processor. Send UNLINK on WhatsApp or use Unlink here to withdraw at any time.
      </p>
    </section>
  )
}
