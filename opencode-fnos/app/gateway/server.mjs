import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { updateAPI } from './update-api.mjs'
import { entry as adaptEntry, resource as adaptResource } from './adapter.mjs'
import { recoverProjectIDs, emptyUpgradeProjectIDs } from './projects.mjs'
import { createEventRelay } from './event-relay.mjs'

const PROTOCOL = JSON.parse(fs.readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'))
export const PREFIX = PROTOCOL.prefix
export const COMPATIBILITY = JSON.parse(fs.readFileSync(new URL('./compatibility.json', import.meta.url), 'utf8'))
export const UI_SHA256 = COMPATIBILITY.ui.sha256
export const SETTINGS_SHA256 = COMPATIBILITY.settings[0].sha256
export const SETTINGS_V2_SHA256 = COMPATIBILITY.settings[1].sha256
export function patchSettings(source, requestedPath) { return adaptResource(source, COMPATIBILITY, requestedPath) }
export function patchUI(source, requestedPath) { return adaptEntry(source, COMPATIBILITY, requestedPath) }
export function stripPrefix(url) {
  const parsed = new URL(url, 'http://gateway.local')
  if (parsed.pathname !== PREFIX && !parsed.pathname.startsWith(PREFIX + '/')) return null
  return (parsed.pathname.slice(PREFIX.length) || '/') + parsed.search
}
function admin(req) {
  return /^\d+$/.test(req.headers[PROTOCOL.headers.userID.toLowerCase()] || '') && req.headers[PROTOCOL.headers.isAdmin.toLowerCase()] === 'true'
}
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'])
function clean(headers) { return Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP.has(key.toLowerCase()) && !key.toLowerCase().startsWith('x-trim-'))) }

export function adaptHTML(source) {
  const entry = [...source.matchAll(/<script\b[^>]*>/gi)].map(([tag]) => {
    const type = tag.match(/\btype\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    const src = tag.match(/\bsrc\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    return type === 'module' ? src : null
  }).find(src => src && /^\/(?:app\/opencode-fnos\/)?_?assets\/index-[^/?]+\.js(?:\?.*)?$/.test(src))
  if (!entry) throw new Error('Unsupported upstream HTML: module entry not found')
  const asset = entry.startsWith(PREFIX + '/') ? entry.slice(PREFIX.length) : entry
  let html = source.replace(/(src|href)=(['"])(\/[^'"]*)\2/g, (match, name, quote, url) =>
    url.startsWith('//') || url === PREFIX || url.startsWith(PREFIX + '/') ? match : `${name}=${quote}${PREFIX}${url}${quote}`)
  const script = `<script src="${PREFIX}/_fnos/bootstrap.js"></script>`
  const charset = /<meta\b[^>]*\bcharset\s*=[^>]*>/i
  html = charset.test(html) ? html.replace(charset, tag => tag + script) : html.replace(/<head\b[^>]*>/i, tag => tag + script)
  return { html, entry: asset }
}

export function createGateway({ port, username, password, version, bootstrap, workspace = process.env.FNOS_WORKSPACE }) {
  const updateToken = crypto.randomBytes(32).toString('hex')
  const authorization = 'Basic ' + Buffer.from((PROTOCOL.backendUsername || username) + ':' + password).toString('base64')
  const events = createEventRelay({port,authorization})
  let patched
  let entryPath = COMPATIBILITY.entry
  let webVersion, metadataRequest
  async function metadata() {
    metadataRequest ||= (async () => {
      const health = await fetch(`http://127.0.0.1:${port}/api/info`, {headers:{authorization},signal:AbortSignal.timeout(3000)})
      if (!health.ok) throw new Error('Backend health unavailable')
      const state = await health.json()
      if (typeof state.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(state.version)) throw new Error('Backend version missing')
      if (!patched) {
        const response = await fetch(`http://127.0.0.1:${port}${entryPath}`, {headers:{authorization},signal:AbortSignal.timeout(10000)})
        if (!response.ok) throw new Error('Upstream module entry unavailable')
        const chunks = []; let bytes = 0
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > 8*1024*1024) throw new Error('UI response too large')
          chunks.push(chunk)
        }
        const source = Buffer.concat(chunks)
        patched = patchUI(source, entryPath)
        webVersion = COMPATIBILITY.web
        if (!webVersion) { patched = undefined; throw new Error('Embedded Web version missing') }
      }
      let projectHistory = [], retiredProjectIDs = []
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/project`, {headers:{authorization},signal:AbortSignal.timeout(3000)})
        if (response.ok) {
          const projects = await response.json()
          let sessions
          try {
            const history = await fetch(`http://127.0.0.1:${port}/api/session?limit=5000&order=desc&parentID=null`, {headers:{authorization},signal:AbortSignal.timeout(3000)})
            if (history.ok) sessions = (await history.json()).data
          } catch { /* Project discovery does not depend on session history. */ }
          let emptyDefault = false
          if (workspace) {
            try { emptyDefault = fs.readdirSync(path.join(workspace, '默认项目')).length === 0 } catch {}
          }
          projectHistory = recoverProjectIDs(projects, sessions, workspace, emptyDefault)
          retiredProjectIDs = emptyUpgradeProjectIDs(projects, sessions, workspace, emptyDefault)
        }
      } catch { /* The native client will still load projects when the API is ready. */ }
      return {prefix:PREFIX,package:version,server:state.version,web:webVersion,updateToken,projectHistory,retiredProjectIDs,displayVersion:`${version} (Server ${state.version} / Web ${webVersion})`}
    })().finally(() => { metadataRequest = undefined })
    return metadataRequest
  }
  const server = http.createServer(async (req, res) => {
    const upstreamPath = stripPrefix(req.url)
    if (upstreamPath === null) { res.writeHead(404); res.end(); return }
    if (!admin(req)) { res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}); res.end('仅飞牛管理员可使用此应用入口。'); return }
    if (events.handle(req,res,upstreamPath,req.headers[PROTOCOL.headers.userID.toLowerCase()])) return
    if (upstreamPath.startsWith('/_fnos/update/')) {await updateAPI(req,res,upstreamPath,undefined,updateToken);return}
    if (['/_fnos/extensions.js', '/_fnos/window-theme.js', '/_fnos/updates.js', '/_fnos/attachment-digest.js', '/_fnos/event-transport.js', '/_fnos/mobile-keyboard.js'].includes(upstreamPath)) {
      res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'})
      const file={'/_fnos/window-theme.js':'./window-theme.mjs','/_fnos/updates.js':'./updates.mjs','/_fnos/extensions.js':'./extensions.mjs','/_fnos/attachment-digest.js':'./attachment-digest.mjs','/_fnos/event-transport.js':'./event-transport.mjs','/_fnos/mobile-keyboard.js':'./mobile-keyboard.mjs'}[upstreamPath]
      res.end(fs.readFileSync(new URL(file, import.meta.url))); return
    }
    if (upstreamPath === '/_fnos/bootstrap.js') {
      try {
        const info = await metadata()
        res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'})
        res.end('window.__FNOS_OPENCODE__=' + JSON.stringify(info) + ';\n' + bootstrap)
      } catch (error) {
        console.error('Gateway bootstrap compatibility error', error.message)
        res.writeHead(502, {'Content-Type':'text/plain'}); res.end('OpenCode Web UI compatibility check failed.')
      }
      return
    }
    const headers = clean(req.headers)
    headers.host = `127.0.0.1:${port}`
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`
    headers.authorization = authorization
    headers['accept-encoding'] = 'identity'
    delete headers['if-none-match']; delete headers['if-modified-since']
    const upstream = http.request({ hostname:'127.0.0.1', port, path:upstreamPath, method:req.method, headers }, response => {
      const outgoing = clean(response.headers)
      delete outgoing['content-length']; delete outgoing.etag; delete outgoing['content-encoding']
      outgoing['cache-control'] = 'no-store'
      if (outgoing.location?.startsWith('/') && !outgoing.location.startsWith(PREFIX + '/')) outgoing.location = PREFIX + outgoing.location
      if (outgoing['set-cookie']) outgoing['set-cookie'] = outgoing['set-cookie'].map(value => value.replace(/Path=\//i, 'Path=' + PREFIX + '/'))
      const mime = String(outgoing['content-type'] || '')
      const html = mime.includes('text/html')
      const main = upstreamPath.split('?')[0] === entryPath.split('?')[0]
      const settings = COMPATIBILITY.settings.some(item => item.path === upstreamPath.split('?')[0])
      const css = mime.includes('text/css')
      if (!html && !main && !settings && !css) {
        const events = mime.includes('text/event-stream')
        if (events) {
          outgoing['x-accel-buffering'] = 'no'
          outgoing['cache-control'] = 'no-store, no-transform'
        }
        res.writeHead(response.statusCode, outgoing); res.flushHeaders()
        // SSE comments are ignored by the native parser. Prime buffering mobile
        // relays without forging server.connected or changing actual events.
        if (events && response.statusCode === 200) res.write(':' + ' '.repeat(16384) + '\n\n')
        response.pipe(res); return
      }
      const chunks = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8*1024*1024) response.destroy(new Error('UI response too large')); else chunks.push(chunk) })
      response.on('end', () => {
        try {
          let data = Buffer.concat(chunks)
          if (main && response.statusCode === 200) {
            const verified = patchUI(data, upstreamPath.split('?')[0])
            webVersion = COMPATIBILITY.web
            patched = verified; data = verified
          }
          else if (settings && response.statusCode === 200) data = patchSettings(data, upstreamPath.split('?')[0])
          else if (html && response.statusCode === 200) {
            const adapted = adaptHTML(data.toString('utf8'))
            if (entryPath !== adapted.entry) patched = undefined
            entryPath = adapted.entry
            data = Buffer.from(adapted.html)
          } else if (css) data = Buffer.from(data.toString().replace(/url\((['"]?)\/(?!\/)/g, `url($1${PREFIX}/`))
          res.writeHead(response.statusCode, outgoing); res.end(data)
        } catch (error) {
          console.error('Gateway UI compatibility error', upstreamPath.split('?')[0], error.message)
          res.writeHead(502, {'Content-Type':'text/plain'}); res.end('OpenCode Web UI compatibility check failed.')
        }
      })
      response.on('error', () => res.destroy())
    })
    upstream.on('error', error => { console.error('Gateway upstream error', req.method, upstreamPath.split('?')[0], error.code || 'request_error'); if (!res.headersSent) res.writeHead(503); res.end('OpenCode service unavailable') })
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    const target = stripPrefix(req.url)
    if (target === null || !admin(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    const remote = net.connect(port, '127.0.0.1', () => {
      // Preserve WebSocket hop headers, but strip all fnOS identity extensions.
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !key.toLowerCase().startsWith('x-trim-')))
      headers.host = `127.0.0.1:${port}`; headers.authorization = authorization
      if (headers.origin) headers.origin = `http://127.0.0.1:${port}`
      remote.write(`GET ${target} HTTP/1.1\r\n` + Object.entries(headers).map(([k,v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
      if (head.length) remote.write(head)
      socket.pipe(remote); remote.pipe(socket)
    })
    remote.on('error', () => socket.destroy()); remote.on('close', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy())
  })
  server.once('close', () => events.close())
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = process.env.TRIM_APPDEST, etc = process.env.TRIM_PKGETC
  const socket = path.join(target, 'app.sock')
  if (fs.existsSync(socket)) {
    if (!fs.lstatSync(socket).isSocket()) throw new Error('Gateway socket path is occupied by a regular file')
    fs.unlinkSync(socket)
  }
  const read = name => fs.readFileSync(path.join(etc, 'web.' + name), 'utf8').replace(/\n$/, '')
  const server = createGateway({port:Number(read('port')),username:read('username'),password:read('password'),version:process.env.TRIM_APPVER || 'unknown',bootstrap:fs.readFileSync(new URL('./bootstrap.js', import.meta.url),'utf8')})
  server.listen(socket, () => { fs.chmodSync(socket, 0o600); console.info('fnOS gateway ready; private app.sock; package',process.env.TRIM_APPVER || 'unknown') })
  const parent = process.ppid
  const owner = Number(process.env.FNOS_SERVER_PID || parent)
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref() }
  setInterval(() => {
    try { process.kill(owner, 0); if (process.ppid !== parent) stop() }
    catch { stop() }
  }, 2000).unref()
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, stop)
}
