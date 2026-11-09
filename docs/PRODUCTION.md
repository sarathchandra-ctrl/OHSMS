# Production runbook — moved out of this repository

**This file is a pointer. The runbook itself is private.**

It was moved on 2026-09-10 following an ISO 27001 audit finding (H-2, A.5.12
classification / A.8.4 access to source code). Ask the maintainer for it — the
root `SECURITY.md` says how to make contact.

## Why it left

This repository is public. The runbook is the operational description of a live
production system: it names the Firebase project, the region, the deployed
function names, the console state that is switched on, and the order in which
the enforcement surfaces are deployed. It also carried a ready-to-run
unauthenticated `curl` against the production `/reports` write endpoint — a
worked example, written to help an operator verify the anonymous QR surface, and
equally a worked example for anybody else.

None of that is a secret in the cryptographic sense, and none of it is a
credential. Publishing it is still the wrong default for a document whose whole
purpose is to describe how to operate the thing.

## What did NOT change

- **No credential was ever in it, and none was rotated.** The audit searched the
  tracked tree and the full 350-commit history for private keys, service-account
  JSON and provider tokens, and found none. `.gitignore` has always covered
  `.env`, `.env.production` and `.firebaserc`.
- **The reasoning that belongs with the code stayed with the code.** Roughly
  seventeen files cite this runbook from comments — `firestore.rules`,
  `functions/index.js`, `stack/lib/retention.js`,
  `src/shared/storage/adapters/firebase.js`, both deploy workflows and others.
  Those references are still correct; they now resolve to this note, and the
  section numbers they cite are unchanged in the private copy.
- **Git history still holds the original.** Rewriting it was considered and
  rejected: it would change every commit SHA and orphan the `v*` release tags
  that tie each production deployment to a commit. Assume the historical
  content is public and defend the system on its merits — which is what App
  Check on the anonymous surfaces, the rules test suite and the tag ruleset are
  for — rather than on the file having been removed.

## What is still here

- `DEPLOYMENT.md` — first-org bootstrap, per-deploy verification, rollback.
- `docs/SECURITY.md` — the **closed** security register. The open half moved
  out in the same change; that file explains the split and the rule for what
  goes where.
- `.github/rulesets/` — the branch and tag rulesets that govern how code reaches
  production, in version control rather than only in the console.
- `.github/workflows/deploy.yml` — the pipeline itself, including the
  `production` environment gate, is unchanged and readable.
