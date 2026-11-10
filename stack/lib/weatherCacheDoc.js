// The slot check, kept out of weatherCache.js so a test can run it without
// a database. A document from another slot is not a hit: that reading belongs
// to a window that has already closed.

export function cachedObservation(doc, slot) {
  if (!doc || !slot || doc.slot !== slot) return null
  if (!doc.obs || typeof doc.obs !== 'object') return null
  return doc.obs
}
