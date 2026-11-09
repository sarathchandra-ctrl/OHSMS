# Data Processing Agreement — template stub

**DRAFT. Not legal advice. Not an executed agreement.** Counsel must complete
and sign this before it is offered to a customer. Placeholders in `[brackets]`
are for the owner; they are not defaults.

This stub exists so a procurement questionnaire has something to attach that
describes *this* product, rather than a generic processor DPA that disagrees
with the architecture.

---

## 1. Parties

- **Controller:** `[customer legal name]`
- **Processor:** `[operator legal name]`
- **System:** WEHS / OHSMS — the multi-tenant occupational health and safety
  application operated by the Processor.

## 2. Subject matter and duration

Processing of personal data, including special-category health data, that the
Controller's users enter into the System, for the duration of the subscription
and any retention period counsel signs in `docs/DATA-RIGHTS.md` / 
`stack/lib/retentionPolicy.js`.

Retention periods in that table that still read `NEEDS_LEGAL_SIGN_OFF` are
**not** processor policy. They are an engineering reading waiting on counsel.

## 3. Nature and purpose

Hosting, storage, retrieval, display, subject-access export, Recycle Bin
purge of manager-deleted records, audit logging, authentication, and error
reporting as configured.

Not a purpose today: malware scanning of sealed medical documents (see
`docs/ADR-0001-malware-scanning.md`). Adding a scanning vendor is a new
purpose and a new subprocessor, not a configuration toggle.

## 4. Types of personal data

As inventoried in `stack/lib/subjectData.js` and sealed per
`src/shared/crypto/policy.js`:

- Identity and employment: names, uids, site/department assignment, training
  records.
- Special category / health: injury and illness reports, GP letters, fit
  notes, medical restrictions, attached clinical documents.
- Operational: incident descriptions, permit documents, inspection photos,
  LOTO procedure photos, committee attendance.

## 5. Categories of data subjects

Employees, contractors, and other persons the Controller records in the
System; members of the public who scan a printed QR token on equipment they
physically reach.

## 6. Processor obligations (headings only)

Counsel to complete against GDPR Art. 28 / DPDP 2023 corresponding duties:

1. Process only on documented instructions.
2. Confidentiality of persons authorised to process.
3. Security measures — point at `docs/SECURITY.md` (closed register) and the
   private production runbook; do not restate live console state here.
4. Subprocessors — `docs/compliance/SUBPROCESSORS.md`. Flow-down, notice,
   objection window: `[counsel to set]`.
5. Assistance with data-subject rights — subject-access export exists;
   erasure is classified, not executed (`docs/DATA-RIGHTS.md` §3).
6. Deletion or return at end of service — `[counsel to set, including backups
   / PITR window]`.
7. Audits — `[counsel to set]`. A pen-test outline is in
   `docs/compliance/PENTEST-SCOPE.md`; no test is claimed by this stub.

## 7. International transfers

Firebase / Google Cloud and Sentry (when a DSN is configured) process data
outside the Controller's country. `[Counsel: SCC / DPDP cross-border
mechanism.]` Do not name a live GCP region in this public file; the private
runbook has it.

## 8. Breach notification

`[Counsel: hours, channel.]` Application errors, when `VITE_SENTRY_DSN` is
set, go to Sentry; hosting uptime failures go to GitHub Actions
(`.github/workflows/uptime.yml`). Neither is a substitute for a personal-data
breach process.

## 9. What this stub is not

- Not a signature page.
- Not a claim that ISO 27001 or SOC 2 has been certified.
  `docs/ISO27001-AUDIT.md` is a pointer to a private self-audit.
- Not permission to send medical attachments to a new vendor.
