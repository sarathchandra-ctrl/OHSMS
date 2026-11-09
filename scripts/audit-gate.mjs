#!/usr/bin/env node
/**
 * Block a merge on high or critical advisories in what actually ships — with a
 * named allowlist rather than a lowered bar.
 *
 * `npm audit --audit-level=critical` was the first version, because one
 * unfixable high (xlsx) would otherwise have made the gate red on the day it
 * shipped, and a gate that is always red is a gate nobody reads. But lowering
 * the threshold hides every OTHER high too, which is most of what a dependency
 * gate exists to catch.
 *
 * So: fail on high and above, and allow exactly the advisories named below,
 * each with a reason and a condition for removing it. Anything not on the list
 * fails. The list is short on purpose — if it grows, that is the signal, not
 * the workaround.
 *
 * ── Which tree ──────────────────────────────────────────────────────────────
 *
 *   node scripts/audit-gate.mjs                  # the app's runtime tree
 *   node scripts/audit-gate.mjs stack            # the server tree
 *
 * and the app tree including devDependencies, which reports everything and
 * never blocks — a critical in the toolchain is not a fact about the shipped
 * product:
 *
 *   node scripts/audit-gate.mjs root-all
 *
 * Why a script rather than a bare `npm audit --omit=dev --audit-level=high`: that bare command reads its verdict from
 * npm's EXIT CODE, which is 1 both when the tree has a high advisory and when
 * npm could not reach the advisory service at all. Those are opposite facts —
 * "the product ships a known vulnerability" and "we learned nothing today" —
 * and CI reported them identically, as a red required check with a stack of
 * registry noise above it.
 */
import { execFileSync } from 'node:child_process'

// Each entry must say why it is tolerable and what closes it. An allowlist
// without those becomes permanent.
// Empty on purpose. The one entry this used to hold was xlsx, removed when
// exports moved to the maintained SheetJS build (docs/SECURITY.md S-18).
// A new high or critical in the runtime tree fails the gate until it is
// fixed or named here with a reason and what closes it.
const ROOT_ALLOWED = {}

/**
 * The trees, and whether each one can stop a merge.
 *
 * `omitDev` is the distinction the whole job is built around: a critical in
 * vitest is a fact about this repository's toolchain, a high in a runtime
 * dependency is a fact about the deployed product, and only the second should
 * block. `blocking: false` trees are reported in full and never change the exit
 * code — they exist so "does not block" is not implemented as "is not
 * mentioned", which is how eleven advisories once sat in the tree unnoticed.
 */
const TREES = {
  root: {
    dir: '.', label: 'runtime tree', omitDev: true, blocking: true, allowed: ROOT_ALLOWED,
  },
  // No allowlist, deliberately: the server tree is small and should stay clean.
  stack: {
    dir: 'stack', label: 'server tree', omitDev: true, blocking: true, allowed: {},
  },
  'root-all': {
    dir: '.', label: 'whole tree, including tooling', omitDev: false, blocking: false, allowed: {},
  },

}

const treeName = process.argv[2] || 'root'
const tree = TREES[treeName]
if (!tree) {
  console.error(`audit-gate: unknown tree "${treeName}". Expected one of: ${Object.keys(TREES).join(', ')}`)
  process.exit(2)
}
const ALLOWED = tree.allowed

// ── Getting a report at all ──────────────────────────────────────────────────
//
// npm audit exits non-zero when it FINDS something, and also when the registry
// refuses to answer. Only the first is a fact about this repository, so the two
// are separated here by whether a parseable report came back — not by the exit
// code, which cannot tell them apart.
//
// The registry side genuinely fails: a 400 "Invalid package tree" from
// /-/npm/v1/security/audits/quick took a required check red on a branch that
// changed no dependency, no package.json and no lockfile, and the identical
// commit passed on re-run minutes later in a fortieth of the time. npm also
// prints "This endpoint is being retired" on every call, so this is not a
// one-off worth waiting out.
//
// Hence: retry the transport failure, and keep failing closed if it persists.
// A few attempts over about a minute covers a blip, which is what this was. It
// does NOT cover a sustained outage, and it should not — "we could not check"
// must never be reported as "nothing to find".
const ATTEMPTS = 4
const BACKOFF_MS = [5000, 15000, 30000]
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * The one line of npm's stderr worth putting in a build log.
 *
 * npm's own `error` object is frequently `{summary: '', detail: ''}`, and the
 * fact that actually explains the failure — "connect ECONNREFUSED", "400 Bad
 * Request" — is on stderr, a few lines above a trailing pointer to a debug log
 * nobody is going to open.
 */
function stderrHint(s) {
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => l.includes('reason:'))
    || lines.find((l) => l.startsWith('npm error') && !l.includes('complete log'))
    || ''
}

/** → { report } on success, or { failure } describing why no report came back. */
function auditOnce({ dir, omitDev }) {
  let raw = ''
  let stderr = ''
  const args = omitDev ? ['audit', '--omit=dev', '--json'] : ['audit', '--json']
  try {
    raw = execFileSync('npm', args, {
      cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e) {
    // The report is still on stdout when npm exits non-zero for findings, and
    // that report is the whole point of running it.
    raw = e.stdout || ''
    stderr = e.stderr || ''
    if (!raw.trim()) return { failure: stderrHint(stderr) || e.message }
  }
  if (!raw.trim()) return { failure: 'npm audit produced no output' }

  let report
  try {
    report = JSON.parse(raw)
  } catch {
    return { failure: 'npm audit output was not JSON' }
  }
  // npm reports a registry refusal as a report-shaped object with an `error`
  // and no vulnerabilities. Treating that as an empty tree is how a broken
  // audit becomes a green check.
  if (report.error) {
    // npm is inconsistent about which of these it fills in, and an unexplained
    // "registry error: unknown" in a red build is a line nobody can act on.
    const e = report.error
    const detail = e.summary || e.detail || e.code || stderrHint(stderr) || JSON.stringify(e).slice(0, 200)
    return { failure: `registry error: ${detail}` }
  }
  if (!report.vulnerabilities && !report.metadata) {
    return { failure: 'report contained neither vulnerabilities nor metadata' }
  }
  return { report }
}

/**
 * → the report, or null when a report-only tree could not get one.
 *
 * Retries are for the BLOCKING trees. A report-only tree spending fifty seconds
 * of CI on a registry that is refusing everyone would buy nothing: it cannot
 * fail the build either way, and the blocking step immediately before it has
 * already done the waiting on the same registry.
 */
function audit(t) {
  const attempts = t.blocking ? ATTEMPTS : 1
  let last = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { report, failure } = auditOnce(t)
    if (report) {
      if (attempt > 1) console.log(`audit-gate: got a report on attempt ${attempt}.`)
      return report
    }
    last = failure
    if (attempt < attempts) {
      const wait = BACKOFF_MS[attempt - 1]
      console.log(`audit-gate: attempt ${attempt} could not get a report (${failure}); retrying in ${wait / 1000}s.`)
      sleep(wait)
    }
  }
  if (!t.blocking) {
    // Said out loud rather than swallowed. The `|| true` this replaced turned a
    // failed advisory scan into an empty one, which reads exactly like a clean
    // tree — and reporting is this step's entire job.
    console.log(`audit-gate: could not audit the ${t.label} — ${last}`)
    console.log('This step never blocks, so the build continues. Nothing was checked.')
    return null
  }
  console.error(`audit-gate: no report after ${attempts} attempts — last failure: ${last}`)
  console.error('Refusing to pass on no evidence: this is "we could not check", not "nothing to find".')
  process.exit(1)
}

// Before the call, not after: a retry or a failure message that arrives above
// the line saying which tree is being audited reads as belonging to the
// previous step.
console.log(`audit-gate: auditing the ${tree.label} (${tree.dir}).`)

const report = audit(tree)

// ── Report-only trees ────────────────────────────────────────────────────────
//
// These replace two bare `npm audit || true` steps. Piping to `|| true` made
// them unable to fail, which was right, but it also made them unable to say
// anything a reader could rely on: a registry error and a clean tree produced
// the same green tick, and the human-formatted output they printed came from
// the retiring quick-audit endpoint.
//
// Same parsed report as the gate above, grouped by severity, exit code always 0.
if (!tree.blocking) {
  if (!report) process.exit(0)
  const found = Object.values(report.vulnerabilities || {})
  if (!found.length) {
    console.log(`\nno advisories in the ${tree.label}.`)
    process.exit(0)
  }
  console.log(`\nadvisories in the ${tree.label} (reported, never blocking):`)
  for (const severity of ['critical', 'high', 'moderate', 'low', 'info']) {
    const at = found.filter((v) => v.severity === severity)
    if (!at.length) continue
    console.log(`  ${severity} (${at.length}):`)
    for (const v of at) {
      console.log(`    ${v.name} — ${v.fixAvailable === false ? 'no fix published' : 'FIX AVAILABLE'}`)
    }
  }
  console.log('\nNothing here blocks a merge. A high or critical in what actually SHIPS is')
  console.log('caught by the blocking steps above; these are the rest of the picture.')
  process.exit(0)
}

const serious = Object.values(report.vulnerabilities || {})
  .filter((v) => v.severity === 'high' || v.severity === 'critical')

const unexpected = serious.filter((v) => !ALLOWED[v.name])
const accepted = serious.filter((v) => ALLOWED[v.name])

for (const v of accepted) {
  console.log(`allowed: ${v.severity} in ${v.name}`)
  console.log(`   why:    ${ALLOWED[v.name].why}`)
  console.log(`   closes: ${ALLOWED[v.name].closes}`)
}

// An entry that no longer matches anything is stale — it should be deleted, not
// left to silence a future advisory in the same package.
for (const name of Object.keys(ALLOWED)) {
  if (!serious.some((v) => v.name === name)) {
    console.log(`stale allowlist entry: ${name} no longer has a high/critical advisory — remove it.`)
  }
}

// ── Moderates: reported, never blocking ──────────────────────────────────────
//
// This gate blocks at high, which is the right threshold: raising it to
// moderate would demand a major-version migration for advisories that are
// sometimes structurally unreachable, and a gate that is red on the day it
// ships teaches everyone to ignore it.
//
// But "does not block" was being implemented as "is not mentioned", and those
// are different things. Two moderate react-router advisories sat in the runtime
// tree — one of them with a fix available and a genuinely reachable sink in the
// post-login redirect — and CI never said a word about either. They were found
// by running `npm audit` by hand (SECURITY.md S-06).
//
// So they are printed, with whether a fix exists, which is the fact that decides
// whether anyone should care. Nothing here changes the exit code.
const moderates = Object.values(report.vulnerabilities || {})
  .filter((v) => v.severity === 'moderate')

if (moderates.length) {
  console.log(`\nmoderate advisories in the ${tree.label} (reported, not blocking):`)
  for (const v of moderates) {
    const fix = v.fixAvailable === false ? 'no fix published' : 'FIX AVAILABLE'
    console.log(`  ${v.name} — ${fix}`)
  }
  console.log('  Assess reachability before acting; record the verdict in docs/SECURITY.md S-06.')
}

if (unexpected.length) {
  console.error(`\naudit-gate: ${unexpected.length} unallowed high/critical advisory in the ${tree.label}:`)
  for (const v of unexpected) {
    console.error(`  ${v.severity.toUpperCase()} ${v.name} — fix available: ${JSON.stringify(v.fixAvailable)}`)
  }
  console.error('\nFix it, or add it to the tree\'s allowlist in scripts/audit-gate.mjs with a reason and what closes it.')
  process.exit(1)
}

console.log(`\naudit-gate: ok — ${accepted.length} allowed, 0 unallowed.`)
