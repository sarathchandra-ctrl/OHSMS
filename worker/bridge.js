// The smallest Node-shaped request/response stack/handler.mjs needs, over a
// Fetch Request, so the same handler serves Cloudflare and local development.
//
// The handler reads `req.method`, `req.url` (path + query), `req.headers`
// (lower-case keys) and iterates `req` for the body; it answers with
// `res.writeHead(status, headers)` and `res.end(body)`.

export function nodeRequest(request) {
  const url = new URL(request.url)
  const headers = {}
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  const body = request.body
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    async *[Symbol.asyncIterator]() {
      if (!body) return
      for await (const chunk of body) yield Buffer.from(chunk)
    },
  }
}

const NO_BODY = new Set([101, 204, 205, 304])

export function nodeResponse() {
  let status = 200
  const headers = new Headers()
  const chunks = []
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  const res = {
    headersSent: false,
    writeHead(code, head = {}) {
      status = code
      for (const [name, value] of Object.entries(head)) {
        if (value !== undefined && value !== null) headers.set(name, String(value))
      }
      this.headersSent = true
      return this
    },
    setHeader(name, value) {
      headers.set(name, String(value))
    },
    write(chunk) {
      if (chunk === undefined || chunk === null) return true
      chunks.push(
        typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
      )
      return true
    },
    end(chunk) {
      this.write(chunk)
      finish()
    },
  }
  function toResponse() {
    if (NO_BODY.has(status)) return new Response(null, { status, headers })
    const size = chunks.reduce((n, c) => n + c.length, 0)
    const body = new Uint8Array(size)
    let at = 0
    for (const c of chunks) {
      body.set(c, at)
      at += c.length
    }
    return new Response(body, { status, headers })
  }
  return { res, done, toResponse }
}
