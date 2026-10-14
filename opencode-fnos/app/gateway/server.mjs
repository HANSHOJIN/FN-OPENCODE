import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const PROTOCOL = JSON.parse(fs.readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'))
export const PREFIX = PROTOCOL.prefix
export const UI_SHA256 = 'f68347d1a8ce586d282b50f77b36d7a09d5af54f6a51f966c26159b451e69c3e'
export const SETTINGS_SHA256 = '44ad5679741f80fa62e4136dac75e87b9d4984aa15e296295f16d899017d923e'
export const SETTINGS_V2_SHA256 = 'fd440ec2b03d098592610b25e51983c525715665f86ee4c65f54247030bd6e7b'
export function patchSettings(source) {
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  if (![SETTINGS_SHA256, SETTINGS_V2_SHA256].includes(hash)) throw new Error('Unsupported upstream settings UI')
  const v2 = hash === SETTINGS_V2_SHA256
  let text = source.toString('utf8')
  const trigger = v2 ? 'a(v,()=>t.t("app.name.desktop"))' : 'r(O,()=>t.t("app.name.desktop"))'
  const content = v2 ? 'r(F.Content,{value:"models",class:"settings-v2-panel",get children(){return r(Kr,{})}})' : 'e(C.Content,{value:"models",class:"no-scrollbar",get children(){return e(cr,{})}})'
  for (const [name, needle] of [['settings navigation', trigger], ['settings content', content]]) {
    if (text.split(needle).length !== 2) throw new Error('Upstream adapter anchor changed: ' + name)
  }
  const nav = v2 ? 'a(L,r(F.Trigger,{value:"fnos-extensions",children:"扩展"}),null),' : 'r(N,e(C.Trigger,{value:"fnos-extensions",children:"扩展"}),null),'
  const panel = v2 ? 'r(F.Content,{value:"fnos-extensions",class:"settings-v2-panel",get children(){return window.__FNOS_OPENCODE__.extensionsPanel()}})' : 'e(C.Content,{value:"fnos-extensions",class:"no-scrollbar",get children(){return window.__FNOS_OPENCODE__.extensionsPanel()}})'
  text = text.replace(trigger, nav + trigger).replace(content, content + ',' + panel)
  if (v2) {
    const permission = 'function Xt(e){const t=Ke(),n=ce(),s=E(()=>{const i=e();if(i)return n().session.lineage.peek(i)?.session.directory});return{accepting:E(()=>{const i=e(),c=s();return!i||!c?!1:t.isAutoAccepting(i,c)}),enabled:E(()=>!!s()),set:i=>{const c=e(),l=s();if(!(!c||!l)){if(i)return t.enableAutoAccept(c,l);t.disableAutoAccept(c,l)}}}}'
    if (text.split(permission).length !== 2) throw new Error('Upstream adapter anchor changed: automatic permission controller')
    text = text.replace(permission, 'function Xt(e){return window.__FNOS_OPENCODE__.permissionController(Dt)}')
  }
  return Buffer.from(text)
}
export function patchUI(source) {
  if (crypto.createHash('sha256').update(source).digest('hex') !== UI_SHA256) throw new Error('Unsupported upstream Web UI; review the gateway adapter')
  let text = source.toString('utf8')
  const router = 'e.router??Qfe},root:'
  const server = 'NJ=()=>location.hostname.includes("opencode.ai")?"http://localhost:4096":location.origin'
  const version = 'Btt={version:qtt}'
  const location = 'll=()=>ag().location'
  const project = 'm={...h?s.data.project.find(p=>p.id===h):s.data.project.find(p=>p.worktree===u.worktree),...u}'
  for (const [name, needle] of Object.entries({router, server, version, location, project})) {
    if (text.split(needle).length !== 2) throw new Error('Upstream adapter anchor changed: ' + name)
  }
  text = text.replace(router, 'e.router??Qfe},base:window.__FNOS_OPENCODE__.prefix,root:')
    .replace(server, 'NJ=()=>location.origin+window.__FNOS_OPENCODE__.prefix')
    .replace(version, 'Btt={version:window.__FNOS_OPENCODE__.displayVersion}')
    .replace(location, 'll=()=>window.__FNOS_OPENCODE__.routeLocation(ag().location)')
    .replace(project, 'm=window.__FNOS_OPENCODE__.projectMetadata({...h?s.data.project.find(p=>p.id===h):s.data.project.find(p=>p.worktree===u.worktree),...u},e)')
    .replaceAll('OpenCode Desktop', 'OpenCode for fnOS')
  return Buffer.from(text)
}
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
  }).find(src => src && /^\/(?:app\/opencode-fnos\/)?assets\/index-[^/?]+\.js(?:\?.*)?$/.test(src))
  if (!entry) throw new Error('Unsupported upstream HTML: module entry not found')
  const asset = entry.startsWith(PREFIX + '/') ? entry.slice(PREFIX.length) : entry
  let html = source.replace(/(src|href)=(['"])(\/[^'"]*)\2/g, (match, name, quote, url) =>
    url.startsWith('//') || url === PREFIX || url.startsWith(PREFIX + '/') ? match : `${name}=${quote}${PREFIX}${url}${quote}`)
  const script = `<script src="${PREFIX}/_fnos/bootstrap.js"></script>`
  const charset = /<meta\b[^>]*\bcharset\s*=[^>]*>/i
  html = charset.test(html) ? html.replace(charset, tag => tag + script) : html.replace(/<head\b[^>]*>/i, tag => tag + script)
  return { html, entry: asset }
}

export function createGateway({ port, username, password, version, bootstrap }) {
  const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
  let patched
  let entryPath = '/assets/index-BkjnPp3h.js'
  let webVersion, metadataRequest
  async function metadata() {
    metadataRequest ||= (async () => {
      const health = await fetch(`http://127.0.0.1:${port}/global/health`, {headers:{authorization},signal:AbortSignal.timeout(3000)})
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
        patched = patchUI(source)
        webVersion = source.toString('utf8').match(/const qtt="([^"]+)"/)?.[1]
        if (!webVersion) { patched = undefined; throw new Error('Embedded Web version missing') }
      }
      return {prefix:PREFIX,package:version,server:state.version,web:webVersion,displayVersion:`${version} (Server ${state.version} / Web ${webVersion})`}
    })().finally(() => { metadataRequest = undefined })
    return metadataRequest
  }
  const server = http.createServer(async (req, res) => {
    const upstreamPath = stripPrefix(req.url)
    if (upstreamPath === null) { res.writeHead(404); res.end(); return }
    if (!admin(req)) { res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}); res.end('仅飞牛管理员可使用此应用入口。'); return }
    if (['/_fnos/extensions.js', '/_fnos/window-theme.js'].includes(upstreamPath)) {
      res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'})
      res.end(fs.readFileSync(new URL(upstreamPath.endsWith('/window-theme.js') ? './window-theme.mjs' : './extensions.mjs', import.meta.url))); return
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
      const settings = ['/assets/dialog-settings-C8957_pd.js', '/assets/index-Don-ekPW.js'].includes(upstreamPath.split('?')[0])
      const css = mime.includes('text/css')
      if (!html && !main && !settings && !css) {
        if (mime.includes('text/event-stream')) outgoing['x-accel-buffering'] = 'no'
        res.writeHead(response.statusCode, outgoing); res.flushHeaders(); response.pipe(res); return
      }
      const chunks = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8*1024*1024) response.destroy(new Error('UI response too large')); else chunks.push(chunk) })
      response.on('end', () => {
        try {
          let data = Buffer.concat(chunks)
          if (main && response.statusCode === 200) {
            const verified = patchUI(data)
            webVersion = data.toString('utf8').match(/const qtt="([^"]+)"/)?.[1]
            patched = verified; data = verified
          }
          else if (settings && response.statusCode === 200) data = patchSettings(data)
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
