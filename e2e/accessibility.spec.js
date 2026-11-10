// ─────────────────────────────────────────────────────────────────────────────
// The accessibility gate that eslint cannot be.
//
// jsx-a11y reads JSX. This app's dominant form control is
// `<Field label="Start time"><input type="time" /></Field>`, where the label and
// the control are joined at runtime — Field generates an id and clones it onto
// its child — so whether that association actually happened is invisible to any
// static rule. It is exactly visible to axe, which reads the rendered DOM.
//
// So the two halves are deliberate and neither is redundant:
//   eslint  — what is statically visible: an icon-only button with no name, a
//             <label> with no htmlFor, a div that answers a click and nothing else.
//   axe     — what only exists once React has run: did the label attach, is the
//             contrast real, is the dialog announced, is anything hidden from the
//             tree that should not be.
//
// Serious and critical only. axe's minor/moderate findings include stylistic
// advice that would make this suite noisy enough to be ignored, and a gate
// people ignore is not a gate. The two that matter are the two that mean a
// person cannot use the page.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const ADMIN = { email: 'admin@acme.test', password: 'password123' }

async function signIn(page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/portal/, { timeout: 20_000 })
}

/**
 * Wait for a page to have actually rendered.
 *
 * NOT waitForLoadState('networkidle'). Every screen in this app holds open
 * Firestore onSnapshot listeners, so the network is never idle and that wait
 * can only ever time out. Waiting on the heading is both faster and a real
 * assertion that the route rendered rather than erroring into a blank.
 */
async function ready(page, headingPattern) {
  await expect(page.getByRole('heading', { name: headingPattern }).first()).toBeVisible({
    timeout: 20_000,
  })
  await settled(page)
}

/**
 * Wait for the fade-ins to finish.
 *
 * Rows and cards animate in from opacity 0 (framer-motion), and axe measures
 * contrast on the composited pixels — so running it mid-fade reports the whole
 * table as failing at whatever opacity it happened to catch. Those are not real
 * findings and, worse, they are FLAKY findings, which is how a suite stops being
 * believed. Waiting for every animation to settle measures what a person
 * actually sees.
 */
async function settled(page) {
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running'),
    undefined,
    { timeout: 10_000 }
  ).catch(() => {})
  // A frame after the last animation, so the composited result is on screen.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/**
 * Run axe and fail on serious/critical.
 *
 * The failure message names the rule, the impact and the first offending
 * selector, because "3 violations" sends whoever reads it back to the browser to
 * find out what they were.
 */
async function expectNoSeriousViolations(page, label) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const detail = serious
    .map((v) => `  ${v.impact} · ${v.id} · ${v.nodes.length} node(s)\n    ${v.nodes[0]?.target?.join(' ')}\n    ${v.help}`)
    .join('\n')

  expect(serious, `${label} has ${serious.length} serious/critical violation(s):\n${detail}`).toEqual([])
}

test('the portal home is clean', async ({ page }) => {
  await signIn(page)
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page, 'Portal home')
})

// A list page is where the icon-only row actions live — the Edit and Delete
// buttons that used to announce as "button, button".
test('a module list page is clean', async ({ page }) => {
  await signIn(page)
  await page.goto('/equipment/extinguishers')
  await ready(page, /repository|extinguisher/i)
  await expectNoSeriousViolations(page, 'Extinguisher repository')
})

// A form is where Field's runtime association is the whole question: every
// control here must come back with a name.
test('a form page is clean, and every control has a name', async ({ page }) => {
  await signIn(page)
  await page.goto('/incidents/new')
  await ready(page, /incident/i)
  await expectNoSeriousViolations(page, 'Report an incident')

  // Said directly as well as via axe, because this is the specific regression
  // the Field change exists to prevent, and a rule id in a report is easier to
  // wave away than a count of nameless boxes.
  const unnamed = await page.locator('input:visible, select:visible, textarea:visible').evaluateAll((els) =>
    els
      .filter((el) => el.type !== 'hidden')
      .filter((el) => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false
        if (el.closest('label')) return false
        return true
      })
      .map((el) => `${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''}${el.name ? `[name=${el.name}]` : ''}`)
  )
  expect(unnamed, `controls with no accessible name: ${unnamed.join(', ')}`).toEqual([])
})

// An open dialog is the case the focus trap and the aria-modal wiring exist for,
// and it is only ever true once the dialog is actually on screen.
test('an open dialog is clean and traps focus', async ({ page }) => {
  await signIn(page)
  await page.goto('/sites')
  await ready(page, /sites/i)

  const addSite = page.getByRole('button', { name: /add site|new site/i }).first()
  await addSite.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await settled(page)

  await expectNoSeriousViolations(page, 'Site dialog')

  // Focus must be inside the dialog, not left behind on the page under it.
  const focusInside = await dialog.evaluate((el) => el.contains(document.activeElement))
  expect(focusInside, 'focus should move into the dialog when it opens').toBe(true)
})

// The skip link is invisible until focused, so the only way to know it works is
// to focus it. It is the first tab stop on every authenticated page.
test('the skip link is the first tab stop and reaches main', async ({ page }) => {
  await signIn(page)
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible()

  // Focus is reset to the document first. After signIn it is left wherever the
  // submit button was before that form unmounted, so tabbing from there tests
  // nothing about where a page STARTS.
  await page.evaluate(() => document.body.focus())
  await page.keyboard.press('Tab')

  const skip = page.getByRole('link', { name: /skip to main content/i })
  await expect(skip).toBeFocused()
  await skip.press('Enter')
  await expect(page.locator('#main')).toBeFocused()
})
