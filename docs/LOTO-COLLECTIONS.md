# Proposal: move LOTO's collections under `/organizations/{orgId}`

**Status: superseded — no longer needed.** This was written for the Firebase
deployment, where many organizations shared one database and LOTO's root
collections were the exception to path-based isolation. The app now runs one
organization per installation on its own server (`AGENTS.md`), so there is no
tenant to isolate and every collection, LOTO's included, is decided by
`stack/policy.mjs`. Kept as a record of the reasoning; nothing below needs
doing.

## The problem

Every module in this app isolates tenants by PATH:

```
/organizations/{orgId}/incidents/{id}
/organizations/{orgId}/extinguishers/{id}
```

LOTO does not. Four of its collections sit at the root with an `orgId` FIELD:

```
/procedures/{id}          { orgId, equipment, isolationPoints, … }
/procedurePhotos/{id}     { orgId, … }
/locks/{id}               { orgId, … }
/technicians/{id}         { orgId, … }
```

These are the records that say which energy sources on a live machine are
isolated and who applied each padlock. They are read after somebody is hurt.

The two isolation styles are not equally safe:

- **Path isolation** is structural. A rule at `/organizations/{orgId}/…` cannot
  serve another tenant's document, because the document is not on that path.
  Forgetting a check narrows what you can do, never what you can see.
- **Field isolation** is a predicate. Every rule touching these collections must
  remember `resource.data.orgId`, on every operation, and one that forgets grants
  cross-tenant access with no other symptom.

That is not hypothetical here. `SECURITY.md` S-08 — *LOTO documents could be
captured by another tenant* — is exactly this shape: an update rule authorised
against `request.resource.data.orgId`, the state AFTER the write, so a writer
could hand themselves another org's procedure by rewriting the field in a single
update. It was fixed by pinning `request.resource.data.orgId ==
resource.data.orgId`. The fix is correct and the class of bug remains available.

A related symptom is already closed: root `/sites` was in the same wildcard,
granted to every approved member, and used by no code at all (S-22).

## Why this has not been done already

The rules are correct today, and the migration touches records that must not be
wrong for a moment. Doing it badly is worse than the exposure it removes.

## Proposed sequence

Four changes, each independently revertible. No step deletes anything the step
after it has not already proved it can live without.

**1. Write both.** `loto/services/*` writes each document to the new
org-scoped path and the old root path in one batch. Reads still come from root.
Nothing changes for users; the new tree begins to fill.

**2. Backfill.** A `functions/` job copies every existing root document to
`/organizations/{orgId}/…`, keyed by the same document id so nothing that
references one by id has to change. Re-runnable, skipping documents already
present, in the shape of the existing backfills (`docId/backfill.js`,
`backfillDocumentVisibility`) — an interrupted run must be safe to run again.
Verify by count and by field-level comparison before proceeding, the way
`crypto/backfill.js` compares before it overwrites.

**3. Read new.** Flip the listeners to the org-scoped path. Keep the dual write.
This is the step to sit on for a release: if anything is missing from the new
tree, it shows up here, and the old tree is still current.

**4. Stop writing root, then remove the grant.** Drop the dual write, then
remove `isLegacyOrgCollection` and its `match /{legacyCol}/{docId}` block from
`firestore.rules` entirely. Add rules tests asserting each of the four root paths
is denied for every role, exactly as S-22 did for `/sites`. The rules-test count
MOVES at this step, and that is the intended semantic change.

`/lotoEvents` gets the same treatment but keep its append-only rule intact
through every step — it is the activity trail an investigator reads, and a
migration is precisely when an append-only guarantee is most likely to be
loosened "temporarily".

## What this is not

Not a rewrite of the LOTO module. The service functions keep their signatures;
only the collection reference changes. The adapter in
`loto/context/AuthContext.jsx` and the module's own role vocabulary are
untouched.

## Cost and risk

- Steps 1–3 are additive and reversible. Step 4 is the only one that removes a
  permission, and by then nothing has used it for a release.
- The backfill duplicates the LOTO data for the duration. Small — these are
  hundreds of documents, not millions.
- The real risk is a half-finished migration left at step 1 or 2 indefinitely,
  which is strictly worse than either end state: two sources of truth, and no
  guarantee about which one a given reader gets. **Do not start this without
  scheduling step 4.**
