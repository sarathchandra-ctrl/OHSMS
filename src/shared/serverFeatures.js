// Features whose server half has not been carried over from the old Cloud
// Functions tier. The screens for them exist; the server jobs they call do
// not, so every button would fail. They are hidden until the job is ported,
// at which point the flag here is the one line that turns the screen back on.
//
//   whatsapp  the WhatsApp site lookup (docs/WHATSAPP.md): linking a number,
//             the organization's numbers, the Meta webhook
//   metabase  ODIN analytics from Metabase: the connection settings and the
//             ODIN / Auditors analytics tabs
//   mail      a report PDF attached to lifecycle mail (drills, meeting
//             minutes, incident and permit prints). Notification mail itself
//             is sent whenever the server has a mailer (stack/notify.mjs) and
//             attaches nothing: a mail carries a reference and a link. While
//             this is off, the screens do not render and upload a PDF no mail
//             would ever attach (shared/print/mailedReport.js).
export const SERVER_FEATURES = {
  whatsapp: false,
  metabase: false,
  mail: false,
}
