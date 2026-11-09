// Centre IDs are keys. "NP-001" and "np-001" are one centre, and a lookup that
// misses because of case files that centre's audits under nobody.
//
// The stored spelling is left alone. Rewriting every site to one case would
// change a value already printed on exports and stored on records that point
// at the site by the code they saved. Comparison folds; the document does not.
//
// Same fold as stack/lib/whatsapp/resolve.js centreIdKey. The two packages
// cannot import each other, and a third spelling is how the WhatsApp lookup
// and the register start answering different questions.

export function normCentreId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

export function sameCentreId(a, b) {
  const left = normCentreId(a)
  return left !== '' && left === normCentreId(b)
}

/**
 * The site this code means.
 *
 * An exact stored code wins, including when another site differs only by case:
 * a record that saved "NP-001" must still find the site that holds "NP-001".
 * A case-only difference matches when exactly one site folds to it. Two sites
 * that fold to the same code and neither is an exact match are ambiguous —
 * guessing would attribute the row to the wrong centre.
 *
 * @returns {{ site: object|null, ambiguous: boolean }}
 */
export function lookupCentreId(sites, code) {
  const raw = String(code ?? '').trim()
  if (!raw) return { site: null, ambiguous: false }
  const list = Array.isArray(sites) ? sites : []
  const exact = list.find((s) => String(s?.code ?? '').trim() === raw)
  if (exact) return { site: exact, ambiguous: false }
  const key = normCentreId(raw)
  const folded = list.filter((s) => normCentreId(s?.code) === key)
  if (folded.length === 1) return { site: folded[0], ambiguous: false }
  if (folded.length > 1) return { site: null, ambiguous: true }
  return { site: null, ambiguous: false }
}
