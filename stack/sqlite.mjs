// A Cloudflare-D1-shaped database over Node's built-in SQLite, so the server
// runs the same code in Docker and in tests as it does on Cloudflare:
//
//   db.prepare(sql).bind(...params) -> statement
//   statement.all()   -> { results: [row…] }
//   statement.first() -> row | null
//   statement.run()   -> { meta: { changes } }
//   db.batch([statement…]) -> one transaction; any error rolls it all back
//   db.exec(sql)      -> runs semicolon-separated statements

import { DatabaseSync } from 'node:sqlite'

function plain(row) {
  return row ? { ...row } : null
}

export function openSqlite(file = ':memory:') {
  const raw = new DatabaseSync(file)
  // WAL lets readers carry on while a write commits; foreign keys are unused.
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA busy_timeout = 5000')

  function statement(sql, params = []) {
    // Prepared when run, not when built: a batch may create the table a later
    // statement in it uses, which is how D1 behaves too.
    let cached = null
    const prepared = {
      all: (...a) => (cached ||= raw.prepare(sql)).all(...a),
      get: (...a) => (cached ||= raw.prepare(sql)).get(...a),
      run: (...a) => (cached ||= raw.prepare(sql)).run(...a),
    }
    return {
      sql,
      bind: (...next) => statement(sql, next),
      async all() {
        return { results: prepared.all(...params).map(plain) }
      },
      async first() {
        return plain(prepared.get(...params))
      },
      async run() {
        const info = prepared.run(...params)
        return { meta: { changes: Number(info.changes) } }
      },
      // Synchronous form for batch().
      _run: () => prepared.run(...params),
      _all: () => prepared.all(...params).map(plain),
    }
  }

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const out = statements.map((s) =>
          /^\s*(SELECT|WITH)\b/i.test(s.sql)
            ? { results: s._all() }
            : { meta: { changes: Number(s._run().changes) } }
        )
        raw.exec('COMMIT')
        return out
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    },
    async exec(sql) {
      raw.exec(sql)
    },
    close: () => raw.close(),
  }
}
