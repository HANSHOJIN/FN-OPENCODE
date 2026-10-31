import http from 'node:http'
import crypto from 'node:crypto'

// A private, bounded SSE subscription per browser. Completed JSON responses pass
// through mobile relays that buffer an HTTP response until it finishes.
export function createEventRelay({port, authorization, pollMs = 8000, idleMs = 65000, maxClients = 16, maxBytes = 4 * 1024 * 1024}) {
  const streams = new Map()
  function reply(res, status, value) {
    if (res.destroyed || res.writableEnded) return
    const body = JSON.stringify(value)
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, no-transform','Content-Length':Buffer.byteLength(body)})
    res.end(body)
  }
  function flush(stream) {
    const pending = stream.pending
    if (!pending) return
    stream.pending = undefined
    clearTimeout(pending.timer)
    if (stream.error) return reply(pending.res, 503, {error:stream.error})
    let bytes = 0
    const chunks = []
    for (const chunk of stream.chunks) {
      if (chunks.length && bytes + chunk.bytes > 512 * 1024) break
      bytes += chunk.bytes; chunks.push({seq:chunk.seq, data:chunk.data})
    }
    reply(pending.res, 200, {stream:stream.id,cursor:chunks.at(-1)?.seq ?? stream.ack,chunks})
  }
  function fail(stream, reason) {
    if (stream.error) return
    stream.error = reason
    stream.last = Date.now() - idleMs + 1000
    stream.request?.destroy(); stream.response?.destroy()
    stream.chunks = []; stream.bytes = 0
    flush(stream)
  }
  function create(owner) {
    const stream = {id:crypto.randomBytes(16).toString('hex'),owner,chunks:[],seq:0,ack:0,bytes:0,last:Date.now()}
    streams.set(stream.id, stream)
    const request = http.get({hostname:'127.0.0.1',port,path:'/api/event',headers:{authorization,accept:'text/event-stream','accept-encoding':'identity'}}, response => {
      stream.response = response
      if (response.statusCode !== 200 || !String(response.headers['content-type']).includes('text/event-stream')) return fail(stream, 'Event backend rejected the connection')
      response.on('data', data => {
        if (stream.error) return
        if (stream.bytes + data.length > maxBytes) return fail(stream, 'Event relay overflow; reconnect required')
        stream.chunks.push({seq:++stream.seq,data:data.toString('base64'),bytes:data.length})
        stream.bytes += data.length
        flush(stream)
      })
      response.on('end', () => fail(stream, 'Event backend disconnected'))
      response.on('error', () => fail(stream, 'Event backend disconnected'))
    })
    stream.request = request
    request.setTimeout(45000, () => fail(stream, 'Event backend timed out'))
    request.on('error', () => fail(stream, 'Event backend unavailable'))
    return stream
  }
  const sweep = setInterval(() => {
    for (const [id, stream] of streams) if (Date.now() - stream.last > idleMs) {
      fail(stream, 'Event subscription expired'); streams.delete(id)
    }
  }, Math.min(5000, idleMs)).unref()
  return {
    handle(req, res, target, owner) {
      const url = new URL(target, 'http://relay.local')
      if (url.pathname !== '/_fnos/events') return false
      if (req.method !== 'GET') {reply(res, 405, {error:'GET required'}); return true}
      const id = url.searchParams.get('stream'), afterText = url.searchParams.get('after') ?? '0'
      if (!/^\d{1,15}$/.test(afterText) || (id !== null && !/^[a-f0-9]{32}$/.test(id))) {reply(res, 400, {error:'Invalid event cursor'}); return true}
      const after = Number(afterText)
      let stream
      if (id) {
        stream = streams.get(id)
        if (!stream || stream.owner !== owner) {reply(res, 404, {error:'Event subscription unavailable'}); return true}
      } else {
        if (after !== 0) {reply(res, 400, {error:'Invalid initial cursor'}); return true}
        if (streams.size >= maxClients) {reply(res, 503, {error:'Event subscription limit reached'}); return true}
        stream = create(owner)
      }
      if (after < stream.ack || after > stream.seq) {reply(res, 409, {error:'Event cursor out of range; reconnect required'}); return true}
      if (stream.pending) {reply(res, 409, {error:'An event read is already pending'}); return true}
      stream.last = Date.now(); stream.ack = after
      while (stream.chunks[0]?.seq <= after) stream.bytes -= stream.chunks.shift().bytes
      const pending = {res,timer:undefined}
      stream.pending = pending
      res.once('close', () => {
        if (stream.pending !== pending) return
        clearTimeout(pending.timer); stream.pending = undefined
      })
      pending.timer = setTimeout(() => flush(stream), pollMs)
      if (stream.chunks.length || stream.error) flush(stream)
      return true
    },
    close() {
      clearInterval(sweep)
      for (const stream of streams.values()) fail(stream, 'Event relay stopped')
      streams.clear()
    },
  }
}
