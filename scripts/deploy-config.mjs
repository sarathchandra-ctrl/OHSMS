// The GitHub deploy's settings step (.github/workflows/deploy-cloudflare.yml).
// The rules are worker/deployConfig.js; this only reads and writes files.
//
//   node scripts/deploy-config.mjs check
//       every setting the deploy reads, checked; names the bad ones and exits 1
//   node scripts/deploy-config.mjs config
//       writes wrangler.deploy.json: wrangler.jsonc with GitHub's overrides
//   node scripts/deploy-config.mjs secrets <secret-list.json> <out.json>
//       writes the Worker secrets the Worker does not have yet, for
//       `wrangler secret bulk`; prints their names, never their values
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { deployConfig, parseJsonc, secretsToSet, settingsProblems } from '../worker/deployConfig.js'

const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'check') {
  const problems = settingsProblems(process.env)
  for (const p of problems)
    console.error(`::error::${p}. Fix it in Settings > Secrets and variables > Actions.`)
  process.exit(problems.length ? 1 : 0)
} else if (cmd === 'config') {
  const base = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'))
  const cfg = deployConfig(base, process.env)
  writeFileSync('wrangler.deploy.json', JSON.stringify(cfg, null, 2) + '\n')
  console.log(
    `Worker "${cfg.name}", database "${cfg.d1_databases?.[0]?.database_name}", bucket "${cfg.r2_buckets?.[0]?.bucket_name}"`
  )
} else if (cmd === 'secrets') {
  const [listFile, outFile] = args
  let existing = []
  try {
    existing = JSON.parse(readFileSync(listFile, 'utf8')).map((s) => s.name)
  } catch {
    // A Worker that does not exist yet has no secrets.
  }
  const set = secretsToSet(process.env, existing)
  writeFileSync(outFile, JSON.stringify(set))
  chmodSync(outFile, 0o600)
  const names = Object.keys(set)
  console.log(
    names.length ? `Setting on the Worker: ${names.join(', ')}` : 'No Worker secrets to set.'
  )
} else {
  console.error('usage: deploy-config.mjs check | config | secrets <list.json> <out.json>')
  process.exit(2)
}
