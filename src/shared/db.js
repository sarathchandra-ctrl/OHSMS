// The first argument module code passes to collection()/doc() — a leftover of
// the Firestore call shape. The Postgres client ignores it; paths are the
// remaining arguments. Kept as a named export so call sites stay unchanged.
export const db = null

export default db
