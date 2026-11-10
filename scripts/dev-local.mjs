// A loopback-only development app with SQLite, local uploads and a local mail
// outbox. Cloudflare/D1/R2 and production credentials are never used here.
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createDedicatedApp } from '../stack/app.mjs'
import { openSqlite } from '../stack/sqlite.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dataDir = process.env.OHSMS_LOCAL_DATA_DIR || join(root, 'stack/data/local')
const port = Number(process.env.OHSMS_LOCAL_PORT || 5173)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('OHSMS_LOCAL_PORT must be a port number between 1 and 65535')
}
const origin = `http://127.0.0.1:${port}`
await mkdir(dataDir, { recursive: true, mode: 0o700 })
const configPath = join(dataDir, 'credentials.json')
let config
try {
  config = JSON.parse(await readFile(configPath, 'utf8'))
} catch (err) {
  if (err.code !== 'ENOENT') throw err
  config = {
    email: 'admin@example.test',
    password: randomBytes(24).toString('base64url'),
    sessionSecret: randomBytes(32).toString('hex'),
    dataKeyMaster: randomBytes(32).toString('base64'),
  }
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

const db = openSqlite(join(dataDir, 'ohsms.sqlite'))
let backend
let vite
let closing = false
async function close() {
  if (closing) return
  closing = true
  await vite?.close()
  if (backend?.listening) {
    await new Promise((resolve) => {
      backend.close(resolve)
      backend.closeAllConnections()
    })
  }
  db.close()
}
try {
  const app = await createDedicatedApp({
    db,
    origin,
    sessionSecret: config.sessionSecret,
    dataKeyMaster: config.dataKeyMaster,
    blobDir: join(dataDir, 'files'),
    // OHSMS_LOCAL_FIRST_SIGNUP=1 starts with nobody in it, to try the first
    // sign-up (/signup). Use a fresh OHSMS_LOCAL_DATA_DIR for it.
    bootstrap:
      process.env.OHSMS_LOCAL_FIRST_SIGNUP === '1'
        ? null
        : {
            orgName: 'Local OHSMS',
            adminEmail: config.email,
            adminPassword: config.password,
            mustChange: false,
          },
    setupCode: process.env.SETUP_CODE || '',
    mail: async (message) => {
      await appendFile(join(dataDir, 'mailbox.ndjson'), JSON.stringify(message) + '\n', {
        mode: 0o600,
      })
      return { sent: true }
    },
  })
  backend = app.server
  await new Promise((resolve, reject) => {
    backend.once('error', reject)
    backend.listen(0, '127.0.0.1', resolve)
  })
  const target = `http://127.0.0.1:${backend.address().port}`
  const paths = ['/data', '/auth/', '/presign', '/blob', '/rpc/', '/health', '/runtime-config.js']
  vite = await createServer({
    root,
    configFile: join(root, 'vite.config.js'),
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: {
        allow: [root, dirname(dirname(fileURLToPath(import.meta.resolve('vite/package.json'))))],
      },
      proxy: Object.fromEntries(paths.map((path) => [path, { target }])),
    },
  })
  await vite.listen()
  process.stdout.write(`\nLocal OHSMS: ${origin}\n`)
  process.stdout.write(`Initial administrator login: ${configPath}\n`)
  process.stdout.write(`Local email outbox: ${join(dataDir, 'mailbox.ndjson')}\n`)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      close().catch(() => {
        process.exitCode = 1
      })
    })
  }
} catch (err) {
  await close()
  throw err
}
