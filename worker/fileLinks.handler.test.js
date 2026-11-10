import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { openSqlite } from '../stack/sqlite.mjs'
import { applySchema, createEngine } from '../stack/engine.mjs'
import { createOwnStackHandler } from '../stack/handler.mjs'
import { blobKeyFrom, createBlobSigner } from '../stack/blobSign.mjs'
import { signSession } from '../stack/session.mjs'
import { createR2FileStore } from './files.js'
import { nodeRequest, nodeResponse } from './bridge.js'

// Download links on records are re-signed as the record is read. A path typed
// into a field the reader may write is not a grant: the link must be one this
// server signed, and name a file /presign would give that reader.
const SECRET = 's'.repeat(40)
const origin = 'https://ehs.example.com'
const key = blobKeyFrom(SECRET)
// A link signed long ago: expired, but genuinely this server's.
const oldLink = (path) => createBlobSigner({ key, origin }).downloadUrl(path, Date.UTC(2025, 0, 1))

async function setup() {
  const db = openSqlite()
  await applySchema(db)
  const engine = createEngine(db)
  const seed = (path, id, data) =>
    engine.commit(null, [{ type: 'set', path, id, data, merge: false }])
  await seed('users', 'mem', { role: 'member', status: 'approved', name: 'Mo' })
  await seed('users', 'mgr', { role: 'manager', status: 'approved', name: 'Mia' })
  const files = createR2FileStore({ bucket: {}, key, origin })
  const handle = createOwnStackHandler({ engine, db, sessionSecret: SECRET, blobStore: files })
  const read = async (uid, id) => {
    const { res, done, toResponse } = nodeResponse()
    await handle(
      nodeRequest(
        new Request(`${origin}/data`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${signSession(SECRET, { sub: uid })}`,
          },
          body: JSON.stringify({ op: 'get', path: 'incidents', id }),
        })
      ),
      res
    )
    await done
    return (await (await toResponse()).json()).doc
  }
  return { seed, files, read }
}

const typed = (path) => `${origin}/blob?op=get&path=${encodeURIComponent(path)}&exp=1&sig=made-up`
const isFresh = (files, link, path) =>
  files.signedPath(link) === path && Number(new URL(link).searchParams.get('exp')) > Date.now()

describe('re-signing download links as records are read', () => {
  it('re-signs a link this server signed, expired or from before expiry existed', async () => {
    const { seed, files, read } = await setup()
    const expired = oldLink('files/photos/a.jpg')
    const oldSig = createHmac('sha256', key)
      .update(['get', 'files/photos/b.jpg'].join('\n'))
      .digest('base64url')
    const legacy = `${origin}/blob?op=get&path=files%2Fphotos%2Fb.jpg&sig=${oldSig}`
    await seed('incidents', 'i1', { title: 'x', photos: [expired, legacy] })
    const got = await read('mem', 'i1')
    expect(isFresh(files, got.photos[0], 'files/photos/a.jpg')).toBe(true)
    expect(isFresh(files, got.photos[1], 'files/photos/b.jpg')).toBe(true)
  })

  it('does not sign a link it never signed, typed into a record', async () => {
    const { seed, read } = await setup()
    const forged = typed('files/photos/someone-else.jpg')
    await seed('incidents', 'i2', { title: 'x', note: forged })
    expect((await read('mem', 'i2')).note).toBe(forged)
  })

  it('does not re-sign a medical file for a reader /presign would refuse it to', async () => {
    const { seed, files, read } = await setup()
    const path = 'files/medical-records/p1/scan.pdf'
    const real = oldLink(path)
    await seed('incidents', 'i3', { title: 'x', attachment: real })
    expect((await read('mem', 'i3')).attachment).toBe(real)
    expect(isFresh(files, (await read('mgr', 'i3')).attachment, path)).toBe(true)
  })

  it('never re-signs a mailed report, for anyone', async () => {
    const { seed, read } = await setup()
    const path = 'files/committee/mailed-reports/m1.pdf'
    const real = oldLink(path)
    await seed('incidents', 'i4', { title: 'x', report: real })
    expect((await read('mgr', 'i4')).report).toBe(real)
  })
})
