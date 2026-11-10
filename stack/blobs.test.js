import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { createBlobStore, blobKeyFrom } from './blobs.mjs'

// The disk store behind /blob on a self-hosted server.
const dirs = []
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'ohsms-blobs-'))
  dirs.push(dir)
  return createBlobStore({ dir, key: blobKeyFrom('s'.repeat(40)), origin: 'https://ehs.example.com' })
}
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

/** Drive handle() with a minimal Node-shaped request and response. */
async function call(files, method, link, body = '') {
  const url = new URL(link)
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method,
    headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
  })
  const out = { status: 0, chunks: [] }
  await new Promise((resolve) => {
    const res = {
      writeHead(status) {
        out.status = status
      },
      write(c) {
        out.chunks.push(Buffer.from(c))
        return true
      },
      end(c) {
        if (c) out.chunks.push(Buffer.from(c))
        resolve()
      },
      on() {},
      once() {},
      emit() {},
    }
    if (method === 'GET') {
      // createReadStream(...).pipe(res) needs a writable; collect instead.
      const sink = new Writable({
        write(chunk, _e, cb) {
          out.chunks.push(Buffer.from(chunk))
          cb()
        },
      })
      sink.writeHead = res.writeHead
      sink.on('finish', resolve)
      const origEnd = sink.end.bind(sink)
      sink.end = (c) => (c ? origEnd(c) : origEnd())
      files.handle(req, sink, url)
      return
    }
    files.handle(req, res, url)
  })
  return { status: out.status, text: Buffer.concat(out.chunks).toString() }
}

describe('files on disk', () => {
  // Every real upload gets a fresh random path, so a second PUT to a path
  // that holds a file is someone swapping out evidence.
  it('never replaces a stored file', async () => {
    const files = await store()
    const path = 'files/photos/evidence.txt'
    expect((await call(files, 'PUT', files.uploadUrl(path), 'original')).status).toBe(200)
    expect((await call(files, 'PUT', files.uploadUrl(path), 'swapped')).status).toBe(409)
    const got = await call(files, 'GET', files.downloadUrl(path))
    expect(got.text).toBe('original')
  })
})
