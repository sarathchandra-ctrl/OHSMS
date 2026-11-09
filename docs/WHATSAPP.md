# WhatsApp site lookup

A linked, approved app user sends a site code or name to the organisation's
WhatsApp Business number and gets **one message** back with that site's safety
summary. Provider: Meta WhatsApp Cloud API, directly (no BSP). Operational
details of the live deployment — the number, the project, the callback URL —
belong in the private runbook, not here (AGENTS.md, "This repository is public").

## What the reply contains

```
🏢 *Demo Fitness Central (DEMO001)*
South · Demo Co

🧯 Fire extinguishers: 6 (1 HPT overdue)
⚠️ Open defects: 3 (2 extinguisher, 1 AED)
🩹 First aid boxes: 2
📋 Pending actions: 4 (1 overdue)
🚑 Incidents: 7 total · 1 open · 2 in last 90 days

📞 *Emergency contacts*
• Police: Demo Police Station — 100
• Site Head: Asha Example — +91 90000 00001

☎️ Safety helpline: 1800 000 0000
🚨 National emergency: 112

Updated 12 Oct, 07:30 IST
Reply with another Centre ID or Centre Name.
```

| Line               | Definition (and the app helper it must equal)                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fire extinguishers | Admin → Sites (`siteStats().extinguishers`); HPT overdue = `deriveStatus().flags.HPT_DUE` on a unit not closed                                                                                                                        |
| Open defects       | The Defect Repository: approved physical-defect reports still on the unit, derived **HPT due** and **Empty** rows, and pending AED / fire-alarm QR reports                                                                            |
| First aid boxes    | `sites/{id}.firstAidBoxes`                                                                                                                                                                                                            |
| Pending actions    | The Central Action Tracker **minus** the equipment source (already counted as defects) and **minus** illness actions; incidents, drills, inspections and internal audit only; overdue = due date before today (IST); "none" when zero |
| Incidents          | `siteStats` matching; open = lifecycle not closed / verified; last 90 days by incident date                                                                                                                                           |
| Emergency contacts | `erpContacts` for the site plus org-wide ones, external services first; the org helpline; 112                                                                                                                                         |

`functions/` cannot import `src/`, so the definitions are ported to
`stack/lib/siteSummary.js` and pinned by
`src/pages/admin/siteSummary.parity.test.js`, which computes every number both
ways over one fixture. A module switched off in `moduleEntitlements` drops its
line. WhatsApp's 4,096-character body limit is enforced by adding contacts until
the budget runs out and ending with "+N more in the app".

An ambiguous name gets an interactive list (≤8 rows) of matching centres; more
than eight asks for the Centre ID. A name that matches nothing says the centre
was not found and, when any are close, lists the closest reachable names.

## Flow

```
Meta ──POST (X-Hub-Signature-256)──► waWebhook
   1 HMAC-SHA256 of the raw body with the App Secret, constant-time compare
   2 waInbound/{sha256(wamid)} create-if-absent  (Meta retries ≠ second reply)
   3 LINK <code>  → waLinkCodes → waLinks/{waId} → one welcome (notifyWhatsAppLinked)
   4 waLinks/{waId} → users/{uid}, re-read live: approved, same org, own password
   5 UNLINK / STOP honoured before the rate limit, including when lookup is off
   6 waOrgSettings enabled === false → one reply, no site data (absent = on)
   7 30/hour, 150/day per number (IST windows); one notice, then silence
   8 which organisation — only the one this profile belongs to. One organisation
     is already known, so the bot asks for the centre immediately; several still
     ask first. MENU and CHANGE ORG ask again
   9 exact Centre ID, then partial/fuzzy Centre Name, ONLY among sites the user reaches.
     One match is the summary. Two to eight is a numbered list (interactive where
     the client supports it). None says not found and suggests the closest names
  10 waSiteSnapshots/{orgId} (one read) + erpContacts → one reply via Graph API
  11 the same reply asks "Do you need any additional details? (Yes/No)". Yes
     reads siteAuditCache/{orgId}/sites/{siteId} (no Metabase call).
     No is a short acknowledgement. No cache entry is "Contact the admin"
  12 waQueryLog row (no message text)
```

**Searching only within reach** is the privacy property. A site outside the
user's grants is not searched at all, so "not yours" and "does not exist" are
the same reply and the bot cannot be used to enumerate the site master.
Unknown or inactive senders get a reply every time, saying how to link
(Settings → Security, or an administrator under Org Settings → Connect with
WhatsApp). The global daily outbound cap is what still bounds a flood.

Counts come from a snapshot rebuilt every 30 minutes (`buildWhatsAppSnapshots`,
for every organisation) and on demand when it is older than an hour.
Emergency contacts are not in that snapshot: the reply reads `erpContacts` at
send time, so a corrected nearest hospital, police station or fire station is
what the next lookup says. A mapped service with no published number is still
named, with its distance when the directory has one.

## Linking

Security → WhatsApp site lookup → **Link WhatsApp** calls `startWhatsAppLink`,
which issues a six-digit, single-use code valid for ten minutes (stored as a
digest). The user sends `LINK 123456` from their phone. The server now knows
both the signed-in uid that asked and the number Meta says sent it — proof of
possession. Five wrong codes from one number in a day block linking from it
for 24 hours. One number per person; a new link replaces the old one.

`notifyWhatsAppLinked` watches `waLinks/{waId}`. A write that creates the
binding, or points the number at a different person or organisation, sends
one welcome through the Cloud API. That covers the code redeeming and an
administrator attaching the number; both set this document. The organisation
name is `organizations/{orgId}.name`, or the name stored on the profile when
the organisation document has none, or "your organisation". The send is a
Cloud API location request: the body is that sentence plus a request to share
a location pin, and the client shows Send location. A client that cannot show
the button gets the same body as plain text, including how to send the pin
from the attachment menu. A pin that arrives afterwards is the location
lookup below. A later save of the same binding does not send again. A code
that fails does not write `waLinks`, so it does not send either. If Graph
refuses the welcome, the failure is logged and the link stays. The webhook
itself does not reply on success — that reply was a second message.

Org Settings → Integrations → **Connect with WhatsApp** is the administrator
path for the same binding. An approved admin of the organisation can turn
lookup on or off for that organisation, add or remove a number, and send one
test message to a number already on the list. Adding a number binds it to an
approved member of that organisation (chosen, or the single profile that
already stores the number). A number already linked to another organisation,
or to a different member of this one, is refused. The handset then has that
member's site reach, re-checked on every message, and the member can still
send UNLINK. The callables are `whatsAppOrgStatus`, `setWhatsAppOrgEnabled`,
`addWhatsAppOrgNumber`, `removeWhatsAppOrgNumber` and `sendWhatsAppOrgTest`.
None of them accepts an organisation id, a token, or an app secret. The
switch is `waOrgSettings/{orgId}`: `enabled: false` turns lookup off for that
organisation only. A missing document leaves it on, which is how the bot
behaved before the switch existed.

## Configuration

Off by default. It answers only when **all** of these are real:

| Name                 | Kind           | Value                                                        |
| -------------------- | -------------- | ------------------------------------------------------------ |
| `WA_APP_SECRET`      | Secret Manager | Meta app's App Secret (verifies webhook signatures)          |
| `WA_ACCESS_TOKEN`    | Secret Manager | System User token with `whatsapp_business_messaging`         |
| `WA_VERIFY_TOKEN`    | Secret Manager | Random string, also typed into Meta's webhook "Verify token" |
| `WA_PHONE_NUMBER_ID` | param          | Cloud API phone number id                                    |
| `WA_ENABLED`         | param          | `true` to switch on — the kill switch                        |
| `WA_GRAPH_VERSION`   | param          | default `v25.0`                                              |
| `WA_DISPLAY_NUMBER`  | param          | the number shown on the Security page                        |
| `WA_DAILY_CAP`       | param          | global outbound replies per day, default 2000                |
| `WA_TEMPLATE_WELCOME`| param          | optional `name+lang` for the welcome; empty sends free-form text |
| `WA_TEMPLATE_TEST`   | param          | optional `name+lang` for the Org Settings test; empty sends free-form text |

The deploy step creates the three secrets as `UNSET-PLACEHOLDER` when missing so
the functions deploy; a placeholder never authenticates anything. Subscribe the
app to the WABA's `messages` field.

## Data protection

See `docs/DATA-RIGHTS.md` ("WhatsApp site lookup"). In short: `waLinks` and
`waQueryLog` are in the subject-access inventory, everything `wa*` is
server-only in the rules (tested in `tests/whatsapp.rules.test.js`), phone
numbers appear outside `waLinks` only as a keyed digest, message text is never
stored, and the profile name in the webhook payload is dropped.

## Location fallback and numbered lists

- If the text matches no centre the user can reach, the bot says it was not found and suggests the closest names (at most three, and only names that are actually close). The same entries are numbered in the text and, on WhatsApp, sent as an interactive list. Replying with the number returns that centre. A shared location is still accepted; the bot no longer asks for one before saying the centre was not found.
- When a location arrives, the bot measures the haversine distance to the user's **accessible** sites that have `lat`/`lng`. It lists up to 5 sites within 25 km. If none is that close, it lists the nearest 3. The list is an interactive list with the same entries numbered in the text.
- The user picks a site by tapping a row, or by replying with its number or code. A tap or a number re-checks access before any data is sent.
- `waSessions/{phoneHash}` holds the conversation: the chosen organisation and the last numbered list (site ids or organisation ids). The list answers to its numbers for 15 minutes (`choicesExpireAtMs`). The document itself lasts 24 hours of idle time (`expiresAtMs`, refreshed on each message), which is how the chat remembers the organisation. The same document holds `detailOffer`, one site id for the audit question, also 15 minutes. The rules deny all client access to it, and `purgeWhatsAppLedgers` sweeps it when `expiresAtMs` has passed. MENU and CHANGE ORG start the organisation question again and drop the offer.
- **Coordinates are never stored.** They are used for one distance calculation in memory. They do not go into `waQueryLog` (intent `location`, outcome `nearby`), `waSessions`, or logs. The name and address Meta attaches are dropped when the message is parsed.

## Additional audit details

After a single centre's summary, WhatsApp asks "Do you need any additional
details? (Yes/No)" — reply buttons, and the same sentence as plain text if
the buttons cannot be shown. Yes reads
`siteAuditCache/{orgId}/sites/{siteId}`, written every 3 hours by
`refreshSiteAuditCache` (asia-south1, Asia/Kolkata) for organisations that
have Metabase configured. The refresh asks two saved questions through the
existing card query: 68611 for the day-0 and N+7 scores, 80321 for the
tickets. The ticket question is asked in 30-day slices and deduped by
ticket id, because one 120-day response was cut off by the row cap. N+7 is
`cas_seven_day_score` when that is a number, otherwise a numeric
`cas_seven_day_result`. Optional filters on those questions are left unset. The window is
120 days. The reply is the audit date, `Score X% · N+7 score Y%` (or
`N+7 score: pending` when the re-score is not in yet, including when the
two scores are equal), open points (at most 10, then "+N more", each with
its status), and a line `Data last extracted: <DD Mon YYYY, h:mm AM/PM> IST`
from that document's `syncedAt`. Open means status Open, On Hold or In
Progress. Tickets that share the audit date are that audit's; otherwise the
open tickets in the window are used, because the ticket question has no
audit id. No document, or a look that found no scored audit, is exactly
"Contact the admin". The webhook does not call Metabase. A failed refresh
leaves the previous document, and each site it skips is logged with the site
id and the reason. No is "Okay." The question expires after 15 minutes, and
Yes checks site reach again before anything is sent.

## Choosing an organisation

WhatsApp remembers the chosen organisation on `waSessions` for 24 hours of
idle time. MENU and CHANGE ORG ask again. A linked user is offered only the
organisation on their live profile (`users/{uid}.orgId`, re-checked every
message). There is no membership list to consult: a person who works for two
companies has two accounts, and the number is linked to one of them.

When that profile has its one organisation, the organisation is already known.
A greeting is answered with the centre prompt. A Centre ID, a Centre Name, or
a location pin is resolved immediately, and the search is still only the sites
that profile can already open. A numbered reply to an organisation list is that
list, not a centre id. A site outside the user's reach is still not searched
at all, and is not offered as a close name.

```
User: hi
Bot:  Acme Fitness.
      Please enter the Centre ID or Centre Name.
      Say MENU to start over, or CHANGE ORG to switch organisation.
      In an emergency call 112.

User: DEMO001
Bot:  🏢 Acme North (DEMO001)
      …emergency contacts, AED line, open defects…
      Reply with another Centre ID or Centre Name.

User: koramangla
Bot:  Centre not found for "koramangla".
      Closest names:
      1. Koramangala Block (BLR1)
      Reply with the number.

User: 1
Bot:  🏢 Koramangala Block (BLR1)
      …

User: (location pin)
Bot:  Your nearest sites:
      1. …

User: change org
Bot:  Which organisation?
      1. Acme Fitness
```
