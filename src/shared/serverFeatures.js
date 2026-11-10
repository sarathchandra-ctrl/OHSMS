// Features whose server half has not been carried over from the old Cloud
// Functions tier. The screens for them exist; the server jobs they call do
// not, so every button would fail. They are hidden until the job is ported,
// at which point the flag here is the one line that turns the screen back on.
//
//   whatsapp  the WhatsApp site lookup (docs/WHATSAPP.md): linking a number,
//             the organization's numbers, the Meta webhook
//   metabase  ODIN analytics from Metabase: the connection settings and the
//             ODIN / Auditors analytics tabs
export const SERVER_FEATURES = {
  whatsapp: false,
  metabase: false,
}
