// ─────────────────────────────────────────────────────────────────────────────
// Pins the CI / hosting hygiene this review closed, so a later edit
// cannot quietly put the previous failure modes back.
//
// These are string assertions against YAML/JSON/JS, not a workflow runner.
// That is deliberate: the defects they catch are all of the form "the file
// says X when it must say Y", and they failed in production without any test
// ever opening the file.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const read = (p) => readFileSync(p, 'utf8')

const WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/uptime.yml',
]

describe('GitHub Actions least privilege', () => {
  it.each(WORKFLOWS)('%s declares permissions: contents: read', (file) => {
    const yml = read(file)
    // A missing block inherits the repository default, which is often write.
    // ISO 27001 LOW-28. The three workflows only check out the tree.
    expect(yml).toMatch(/permissions:\s*\n\s+contents:\s+read/)
  })
})

describe('Playwright does not reuse a CI dev server', () => {
  it('reuseExistingServer is off when CI is set', () => {
    const cfg = read('playwright.config.js')
    // Unconditional `true` would let the capped-reads job reuse the previous
    // step's Vite process, which was started without VITE_TEST_READ_CAP.
    expect(cfg).toMatch(/reuseExistingServer:\s*!process\.env\.CI/)
    expect(cfg).not.toMatch(/reuseExistingServer:\s*true/)
  })
})

describe('700 is not a white-text fill', () => {
  // After the dark-kit remap, 700/800/900 are pastel text-on-wash stops.
  // `bg-cyan-700 text-white` painted #67e8f9 under white at 1.44:1, and axe
  // failed the extinguisher list on the quote button. 600 is the fill that
  // still carries white. Decorative 700 without white text is fine.
  const FILL_700 =
    /(?:bg|hover:bg|file:bg|hover:!bg)-(?:cyan|sky|blue|green|lime|emerald|teal|amber|orange|red|rose|violet|purple|fuchsia|pink|brand)-(?:700|800|900)/

  function walk(dir, acc = []) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, acc)
      else if (/\.(js|jsx|css)$/.test(name)) acc.push(p)
    }
    return acc
  }

  it('does not pair remapped 700/800 fills with text-white', () => {
    const hits = []
    for (const file of walk('src')) {
      if (file.includes('.test.')) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const trimmed = line.trim()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
            return
          if (!FILL_700.test(line)) return
          if (!/text-white/.test(line)) return
          hits.push(`${file}:${i + 1}: ${trimmed}`)
        })
    }
    expect(hits, hits.join('\n')).toEqual([])
  })
})

describe('uptime check and health file', () => {
  it('the scheduled workflow curls /health.json and does not inherit write', () => {
    const yml = read('.github/workflows/uptime.yml')
    expect(yml).toMatch(/cron:\s*'.*'/)
    expect(yml).toMatch(/health\.json/)
    expect(yml).toMatch(/vars\.PRODUCTION_HOSTING_URL/)
    expect(yml).toMatch(/permissions:\s*\n\s+contents:\s+read/)
  })

  it('serves a static health file', () => {
    const health = JSON.parse(read('public/health.json'))
    expect(health).toMatchObject({ status: 'ok', service: 'wehs' })
  })
})

describe('malware scanning stays a decision, not a pretend scanner', () => {
  it('does not add a ClamAV / scanning-vendor package', () => {
    const root = JSON.parse(read('package.json'))
    const fn = JSON.parse(read('stack/package.json'))
    const names = [
      ...Object.keys(root.dependencies || {}),
      ...Object.keys(root.devDependencies || {}),
      ...Object.keys(fn.dependencies || {}),
      ...Object.keys(fn.devDependencies || {}),
    ].join(' ')
    expect(names).not.toMatch(/clamav|clamscan|virus-total|virustotal|opswat/i)
  })

  it('still asserts that a genuine PDF with a payload passes the sniffer', () => {
    const test = read('src/shared/storage/sniffType.test.js')
    expect(test).toMatch(/passes a real PDF regardless of what is inside it/)
    expect(read('docs/ADR-0001-malware-scanning.md')).toMatch(/Sniff ≠ malware scan/)
  })
})

