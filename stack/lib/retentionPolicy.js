/**
 * Retention periods by record class — scaffolding for legal sign-off.
 *
 * `stack/lib/subjectData.js` already classifies every personal-data source
 * as statutory / anonymise / erasable. That table is an engineering reading of
 * the law, not advice, and it encodes a CLASS, not a PERIOD. A record classed
 * STATUTORY is kept forever, which is itself a data-protection finding:
 * indefinite retention is not lawful merely because some retention is.
 *
 * This file is the period table that was missing. Every row that is not the
 * Recycle Bin's already-enforced 30-day purge is marked NEEDS_LEGAL_SIGN_OFF.
 * Nothing here starts deleting live statutory or medical records. The nightly
 * sweep (`purgeSoftDeleted`) still only destroys documents a manager has
 * already put in the Recycle Bin, after thirty days.
 *
 * Pure. No Firestore. `retention.js` is the destructive planner; this is the
 * policy it must not outrun.
 */

import { PURGEABLE } from './retention.js'
import { SUBJECT_SOURCES, STATUTORY, ANONYMISE, ERASABLE } from './subjectData.js'

/** Marker counsel must replace. A number in this file is a proposal, not a rule. */
export const NEEDS_LEGAL_SIGN_OFF = 'NEEDS_LEGAL_SIGN_OFF'

/**
 * Live age-based purge of records nobody has deleted.
 *
 * Off, and it stays off until someone with legal authority puts a period on a
 * class AND flips this. The Recycle Bin sweep is a different job: it honours a
 * manager's delete, after a delay, and already runs. Confusing the two is how
 * occupational-health records get destroyed because a default looked tidy.
 */
export const LIVE_AGE_PURGE_ENABLED = false

/** Recycle Bin window — already claimed by the UI and enforced by purgeSoftDeleted. */
export const RECYCLE_BIN_DAYS = 30

/**
 * Record classes a privacy review will ask about.
 *
 * `proposedPeriod` is what an engineer thinks the question is, not what the
 * law requires. Jurisdiction changes the number; this app is multi-tenant.
 *
 * `livePurge` is always false here. `recycleBin` is true only for collections
 * that already have a soft-delete path and a PURGEABLE entry.
 */
export const RECORD_CLASSES = [
  {
    path: 'injuries',
    class: STATUTORY,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote:
      'Occupational injury records carry a statutory minimum in most jurisdictions. ' +
      'An injury nobody deletes is kept indefinitely today. See DATA-RIGHTS.md §3.',
    livePurge: false,
    recycleBin: true,
    counselMustSign:
      'How long after the injury date must a report be kept, and may it then be destroyed? Per-tenant or global?',
  },
  {
    path: 'illnesses',
    class: STATUTORY,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote:
      'Exposure / health-surveillance records often carry the longest statutory periods.',
    livePurge: false,
    recycleBin: true,
    counselMustSign:
      'Retention period for occupational illness and health-surveillance files, by jurisdiction if it differs.',
  },
  {
    path: 'incidents',
    class: STATUTORY,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote:
      'Accident record; employer evidence of the event. Purging an incident does not cascade into injuries.',
    livePurge: false,
    recycleBin: true,
    counselMustSign:
      'Retention period for incident / accident records. Confirm injuries continue to outlive a purged parent.',
  },
  {
    path: 'consultations',
    class: STATUTORY,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote:
      'Minutes of statutory safety consultation. Who attended is the point of the record.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'How long committee minutes must be kept.',
  },
  {
    path: 'trainingRecords',
    class: STATUTORY,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote: 'Proof of competence; often required for employment and beyond.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'Retention of training / competence records after employment ends.',
  },
  {
    path: 'auditLogs',
    class: STATUTORY,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote:
      'Append-only (stack/policy.mjs). Erasing from it is not currently possible even if it were lawful.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'Whether the audit trail may ever be truncated, and after how long.',
  },
  {
    path: 'users',
    class: ANONYMISE,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote:
      'Account record. Removing it outright orphans authored records that name the uid.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'Anonymise vs delete of the directory entry after a person leaves.',
  },
  {
    path: 'mockDrills',
    class: ANONYMISE,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote:
      'Drill performance should survive for safety reporting; it need not name the warden once closed.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'Whether closed drills may be anonymised, and after how long.',
  },
  {
    path: 'trainingAssignments',
    class: ERASABLE,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote: 'Scheduling, not a safety record. No Recycle Bin path today.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'Whether resolved assignments may be deleted, and after how long.',
  },
  {
    path: 'trainingRequests',
    class: ERASABLE,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote: 'A request to attend; carries no safety evidence once resolved.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'Whether resolved requests may be deleted, and after how long.',
  },
  {
    path: 'erpContacts',
    class: ERASABLE,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote: 'A contact-list entry. Remove the person and the entry has no subject.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: 'Whether leftover contact rows may be deleted when the person leaves.',
  },
  {
    path: 'technicians',
    class: ERASABLE,
    proposedPeriod: NEEDS_LEGAL_SIGN_OFF,
    proposedPeriodNote: 'The list of people authorised to apply a lock. Name and contact only.',
    livePurge: false,
    recycleBin: false,
    counselMustSign:
      'Whether a removed technician’s register entry may be deleted, and after how long.',
  },
  {
    path: 'locks',
    class: 'operational',
    proposedPeriod: 'kept while in the register',
    proposedPeriodNote: 'Padlock register: a lock number and a type. Holds no name.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: null,
  },
  // Owner decision: a closed LOTO permit lives one year, then goes — with its
  // events and attachments. 'operational' (like the equipment registers) because
  // this is a signed period, not a proposal awaiting counsel, and it runs in its
  // OWN sweep (purgeClosedLotoPermits), not through planLiveAgePurge, whose flag
  // stays off for every personal-data class.
  {
    path: 'lotoPermits',
    class: 'operational',
    proposedPeriod: '1 year after closure',
    proposedPeriodNote:
      'Closed permits only (returned, rejected, withdrawn, emergency removal). An open permit is never purged. ' +
      'Own sweep: purgeClosedLotoPermits; constant LOTO_PERMIT_RETENTION_DAYS.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: null,
  },
  // WhatsApp site lookup. Owner decisions, recorded the same way as
  // lotoPermits: a signed period with its own sweep (purgeWhatsAppLedgers,
  // table in whatsapp/retention.js), not a proposal for planLiveAgePurge.
  {
    path: 'waLinks',
    class: 'operational',
    proposedPeriod: 'until the user unlinks',
    proposedPeriodNote:
      'Consent record: the WhatsApp number and the uid it was proven for, or attached to by an ' +
      'organisation administrator. Deleted on UNLINK / STOP, on the Security page, by that ' +
      'administrator in Org Settings, or by an erasure request. No age purge — consent does not expire.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: null,
  },
  {
    path: 'waQueryLog',
    class: 'operational',
    proposedPeriod: '90 days',
    proposedPeriodNote:
      'Which site a linked user looked up, and the outcome. No message text. Own sweep: ' +
      'purgeWhatsAppLedgers; constant WA_RETENTION in whatsapp/retention.js.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: null,
  },
  {
    path: 'waSessions',
    class: 'operational',
    proposedPeriod: '15 minutes',
    proposedPeriodNote:
      'The site ids of the last WhatsApp pick-list, so a numbered reply can answer it. Never a location. ' +
      'Own sweep: purgeWhatsAppLedgers.',
    livePurge: false,
    recycleBin: false,
    counselMustSign: null,
  },
  {
    path: 'extinguishers',
    class: 'operational',
    proposedPeriod: `${RECYCLE_BIN_DAYS} days after Recycle Bin`,
    proposedPeriodNote:
      'Equipment register. Already in PURGEABLE after a manager deletes the asset.',
    livePurge: false,
    recycleBin: true,
    counselMustSign: null,
  },
  {
    path: 'aeds',
    class: 'operational',
    proposedPeriod: `${RECYCLE_BIN_DAYS} days after Recycle Bin`,
    proposedPeriodNote: 'Same Recycle Bin sweep as extinguishers, including the public QR mirror.',
    livePurge: false,
    recycleBin: true,
    counselMustSign: null,
  },
  {
    path: 'fas',
    class: 'operational',
    proposedPeriod: `${RECYCLE_BIN_DAYS} days after Recycle Bin`,
    livePurge: false,
    recycleBin: true,
    counselMustSign: null,
  },
  {
    path: 'signages',
    class: 'operational',
    proposedPeriod: `${RECYCLE_BIN_DAYS} days after Recycle Bin`,
    livePurge: false,
    recycleBin: true,
    counselMustSign: null,
  },
]

/** What counsel is being asked to sign. Not legal advice. */
export function counselSignOffQuestions() {
  return RECORD_CLASSES.filter((row) => row.counselMustSign).map((row) => ({
    path: row.path,
    class: row.class,
    question: row.counselMustSign,
    currentPeriod: row.proposedPeriod,
  }))
}

/**
 * Classes the nightly sweep may already destroy — manager-deleted, past the
 * Recycle Bin window, listed in PURGEABLE. Operational equipment is in this
 * set. So are incidents / illnesses / injuries, because a manager put them in
 * the bin; that is not a live-age purge of statutory records.
 */
export function recycleBinPurgeablePaths() {
  return PURGEABLE.map((p) => p.collection)
}

/**
 * Plan a live-age purge. Always empty while LIVE_AGE_PURGE_ENABLED is false,
 * and always empty for STATUTORY / medical classes even if someone flips the
 * flag without putting a signed period on the row.
 *
 * Exists so "optional scheduled purge" has a seam that tests can pin, rather
 * than a comment promising we will not auto-delete health records.
 */
export function planLiveAgePurge(docs = [], classRow, { now = Date.now() } = {}) {
  if (!LIVE_AGE_PURGE_ENABLED) {
    return {
      purge: [],
      keep: (docs || []).map((d) => ({ id: d?.id, reason: 'live age-purge disabled' })),
    }
  }
  if (!classRow || classRow.livePurge !== true) {
    return {
      purge: [],
      keep: (docs || []).map((d) => ({ id: d?.id, reason: 'class not live-purgeable' })),
    }
  }
  if (classRow.class === STATUTORY || classRow.proposedPeriod === NEEDS_LEGAL_SIGN_OFF) {
    return {
      purge: [],
      keep: (docs || []).map((d) => ({ id: d?.id, reason: 'statutory / unsigned period' })),
    }
  }
  return {
    purge: [],
    keep: (docs || []).map((d) => ({ id: d?.id, reason: 'no signed period encoded' })),
    now,
  }
}

/** Drift guard: every SUBJECT_SOURCES path should appear, or be a child of one that does. */
export function policyCoversSubjectSources() {
  const covered = new Set(RECORD_CLASSES.map((r) => r.path))
  return SUBJECT_SOURCES.filter((s) => {
    const root = (s.path || '').split('/')[0]
    return !covered.has(s.path) && !covered.has(root)
  })
}
