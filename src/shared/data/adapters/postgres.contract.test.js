import { openSqlite } from '../../../../stack/sqlite.mjs'
import { applySchema, createEngine } from '../../../../stack/engine.mjs'
import { createPostgresAdapter } from './postgres'
import { defineDataContract } from './contractSuite'

const db = openSqlite()
await applySchema(db)
const engine = createEngine(db)

let current = null
async function open() {
  if (current) await current._reset()
  current = createPostgresAdapter(engine)
  return current
}

// Subscriber work is a query, so a zero-delay timer can win the race and
// assert before the callback. Wait until that query has delivered.
const tick = async () => {
  await new Promise((r) => setTimeout(r, 0))
  if (current?._idle) await current._idle()
  await new Promise((r) => setTimeout(r, 0))
}

defineDataContract(open, { tick, nullMatchesMissing: true, isolated: false })
