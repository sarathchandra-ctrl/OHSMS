// Outgoing mail from the Worker, through Resend's HTTP API (Workers have no
// SMTP). Settings: MAIL_FROM (var, e.g. "OHSMS <noreply@example.com>",
// on a domain verified in Resend) and RESEND_API_KEY (secret).
//
// Returns { sent } and never throws: a mail that could not be sent is logged,
// not surfaced to the person who asked for it.

export function resendMailer({ apiKey, from, fetchImpl = fetch }) {
  if (!apiKey || !from) return null
  return async ({ to, subject, text }) => {
    try {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      })
      if (!res.ok) {
        console.error('mail not sent', res.status, (await res.text().catch(() => '')).slice(0, 300))
        return { sent: false }
      }
      return { sent: true }
    } catch (err) {
      console.error('mail not sent', err?.message || err)
      return { sent: false }
    }
  }
}
