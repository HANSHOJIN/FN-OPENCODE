import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import vm from 'node:vm'
import { attachmentDigest } from '../opencode-fnos/app/gateway/attachment-digest.mjs'
import { createGateway, adaptHTML, patchUI, patchSettings, stripPrefix, PREFIX, UI_SHA256, COMPATIBILITY } from '../opencode-fnos/app/gateway/server.mjs'

const fixtureRoot = new URL('../.build/upstream-ui', import.meta.url)
function officialUI() {
  return fs.readFileSync(new URL('.' + COMPATIBILITY.entry, fixtureRoot.href + '/'))
}
function officialAsset(item) {
  return fs.readFileSync(new URL('.' + item.path, fixtureRoot.href + '/'))
}

test('HTML discovers the module entry and injects bootstrap after charset without double prefixes',()=>{
 const result=adaptHTML('<head><meta charset="utf-8"><script src="/assets/index-renamed.js" type="module"></script><link href="/app/opencode-fnos/icon.png"></head>')
 assert.equal(result.entry,'/assets/index-renamed.js')
 assert.ok(result.html.indexOf('charset')<result.html.indexOf('_fnos/bootstrap'))
 assert.ok(!result.html.includes(PREFIX+PREFIX))
 assert.throws(()=>adaptHTML('<head><script src="/unknown.js"></script></head>'),/module entry/)
})

test('gateway accepts only its declared prefix', () => {
  assert.equal(stripPrefix(PREFIX + '/global/event?x=1'), '/global/event?x=1')
  assert.equal(stripPrefix('/app/opencode-fnos-other/'), null)
  assert.equal(stripPrefix(PREFIX + '/../private'), null)
})

test('verified official 2.2.2 UI supports fnOS routing and truthful versions', () => {
  const code = patchUI(officialUI()).toString()
  assert.ok(code.includes('base:window.__FNOS_OPENCODE__.prefix'))
  assert.ok(code.includes('location.origin+window.__FNOS_OPENCODE__.prefix'))
  assert.ok(code.includes('version:window.__FNOS_OPENCODE__.displayVersion'))
  assert.ok(code.includes('version:`2.2.2`'), 'Keep the actual upstream version')
  assert.ok(!code.includes('navigator.serviceWorker.register(`/sw.js`)'))
  assert.throws(() => patchUI(Buffer.from('different build')), /Unsupported/)
})

test('official attachment IDs support HTTP without Web Crypto', async () => {
  const source = officialAsset(COMPATIBILITY.settings.find(a => a.role === 'router')).toString()
  const native = source.match(/async function Co\(e\)\{.*?\}(?=async function)/)?.[0]
  assert.ok(native)
  const context = {crypto:{getRandomValues: a => crypto.webcrypto.getRandomValues(a)}, Uint8Array}
  const id = await vm.runInNewContext('(' + native + ')', context)(new File([Buffer.alloc(11264,97)], '项目移交.MD'))
  assert.match(id, /^[a-f0-9]{32}$/)
})

test('all native settings and router chunks retain their hash gates', () => {
  for (const item of COMPATIBILITY.settings) {
    const code = patchSettings(officialAsset(item)).toString()
    if (item.role === 'settings') {
      assert.ok(code.includes('value:`fnos-updates`'))
      assert.ok(code.includes('window.__FNOS_OPENCODE__.updatesPanel()'))
      for (const tab of ['extensions','projects','workspaces','providers']) assert.ok(code.includes('value:`'+tab+'`'))
    } else if (item.role === 'settings-route') assert.ok(code.includes('"fnos-updates":!0'))
    else if (item.role === 'projects') assert.ok(code.includes('window.__FNOS_OPENCODE__.storedProjectIDs(e.scope())'))
    else assert.ok(code.includes('window.__FNOS_OPENCODE__.routeLocation(_n().location)'))
  }
  assert.throws(() => patchSettings(Buffer.from('different build')), /Unsupported/)
})

test('fresh browser storage recovers NAS projects while saved choices and other servers remain isolated', () => {
  const asset = COMPATIBILITY.settings.find(item => item.role === 'projects')
  const code = patchSettings(officialAsset(asset)).toString()
  const native = code.match(/function V\(e\)\{.*?\}(?=function)/)?.[0]
  assert.ok(native)
  const recover = scope => scope === 'local' ? ['remembered-project'] : []
  const create = vm.runInNewContext('(' + native + ')', {window:{__FNOS_OPENCODE__:{storedProjectIDs:recover}}})
  const state = {usedProjectIDs:{},lastProjectID:{}}
  assert.deepEqual([...create({scope:()=>'local',store:state}).used()], ['remembered-project'])
  assert.deepEqual([...create({scope:()=>'remote-server',store:state}).used()], [])
  state.usedProjectIDs.local = []
  assert.deepEqual([...create({scope:()=>'local',store:state}).used()], [])
  state.usedProjectIDs.local = ['custom-choice']
  assert.deepEqual([...create({scope:()=>'local',store:state}).used()], ['custom-choice'])
})

test('HTTP, SSE and WebSocket forwarding preserve auth and stream bytes', async () => {
  const auth = 'Basic ' + Buffer.from('opencode:private-test-password').toString('base64')
  const backend = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, auth)
    assert.ok(!Object.keys(req.headers).some(key=>key.startsWith('x-trim-')))
    if (req.url === '/global/event') { res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write('data: first\n\n'); return }
    res.writeHead(200, {'Content-Type':'text/html'});res.end('<head><meta charset="utf-8"></head><script type="module" src="/assets/index-test.js"></script>')
  })
  const sockets = new Set()
  backend.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  backend.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/pty/test/connect?ticket=abc')
    assert.equal(req.headers.authorization, auth)
    assert.ok(!Object.keys(req.headers).some(key=>key.startsWith('x-trim-')))
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.from([0x81,2,0x6f,0x6b]))
  })
  await new Promise(resolve => backend.listen(0,'127.0.0.1',resolve))
  const gateway = createGateway({port:backend.address().port,username:'test',password:'private-test-password',version:'1.19.0-4',bootstrap:'/* bootstrap */'})
  await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${gateway.address().port}`
  const headers = {'X-Trim-Userid':'1000','X-Trim-Isadmin':'true','X-Trim-Future-Identity':'must-not-leak'}
  try {
    assert.equal((await fetch(origin + PREFIX)).status,403)
    assert.equal((await fetch(origin + PREFIX,{headers:{...headers,'X-Trim-Isadmin':'false'}})).status,403)
    const page = await (await fetch(origin + PREFIX + '/', {headers})).text()
    assert.ok(page.includes(`src="${PREFIX}/_fnos/bootstrap.js"`))
    assert.ok(page.includes(`src="${PREFIX}/assets/index-test.js"`))
    const digestPath = origin + PREFIX + '/_fnos/attachment-digest.js'
    assert.equal((await fetch(digestPath)).status, 403)
    const digestModule = await fetch(digestPath, {headers})
    assert.equal(digestModule.status, 200)
    assert.match(digestModule.headers.get('content-type'), /javascript/)
    assert.ok((await digestModule.text()).includes('export async function attachmentDigest'))
    const controller = new AbortController()
    const stream = await fetch(origin + PREFIX + '/global/event',{headers,signal:controller.signal})
    assert.equal(stream.headers.get('x-accel-buffering'),'no')
    assert.ok(new TextDecoder().decode((await stream.body.getReader().read()).value).includes('data: first'))
    controller.abort()
    await new Promise((resolve,reject) => {
      const socket = net.connect(gateway.address().port,'127.0.0.1', () => socket.write(`GET ${PREFIX}/pty/test/connect?ticket=abc HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nX-Trim-Userid: 1000\r\nX-Trim-Isadmin: true\r\n\r\n`))
      let buffer = Buffer.alloc(0)
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('WebSocket timeout')) })
      socket.on('data', data => { buffer=Buffer.concat([buffer,data]);if(buffer.includes(Buffer.from([0x81,2,0x6f,0x6b]))){assert.ok(buffer.toString().includes('101 Switching Protocols'));socket.destroy();resolve()} })
      socket.on('error',reject)
    })
  } finally {
    for (const socket of sockets) socket.destroy()
    gateway.closeAllConnections();backend.closeAllConnections()
    gateway.close();backend.close()
  }
})

test('renamed module entries still require a verified hash and metadata uses real version values',async()=>{
 let broken=false
 const backend=http.createServer((req,res)=>{
  if(req.url==='/api/info'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({healthy:true,version:'9.8.7'}));return}
  if(req.url==='/assets/index-renamed.js'){res.setHeader('Content-Type','text/javascript');res.end(broken?'changed upstream':officialUI());return}
  if(req.url==='/assets/index-lazy.js'){res.setHeader('Content-Type','text/javascript');res.end('/* unrelated lazy module */');return}
  res.setHeader('Content-Type','text/html');res.end('<head><meta charset="utf-8"><script type="module" src="/assets/index-renamed.js"></script></head>')
 })
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))
 const gateway=createGateway({port:backend.address().port,username:'test',password:'test',version:'test-package',bootstrap:'/* test */'})
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${gateway.address().port}${PREFIX}`,headers={'X-Trim-Userid':'0','X-Trim-Isadmin':'true'}
 try {
  assert.equal((await fetch(base+'/',{headers})).status,200)
  const boot=await(await fetch(base+'/_fnos/bootstrap.js',{headers})).text()
  assert.ok(boot.includes('Server 9.8.7 / Web 2.2.2'))
  const metadata=JSON.parse(boot.slice('window.__FNOS_OPENCODE__='.length,boot.indexOf(';\n')))
  assert.match(metadata.updateToken,/^[a-f0-9]{64}$/)
  assert.equal((await fetch(base+'/_fnos/bootstrap.js')).status,403)
  assert.equal((await fetch(base+'/_fnos/update/request',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action:'rollback'})})).status,403)
  assert.equal((await fetch(base+'/assets/index-renamed.js',{headers})).status,200)
  assert.equal((await fetch(base+'/assets/index-lazy.js',{headers})).status,200)
  broken=true
  assert.equal((await fetch(base+'/assets/index-renamed.js',{headers})).status,502)
 } finally {gateway.closeAllConnections();backend.closeAllConnections();gateway.close();backend.close()}
})
