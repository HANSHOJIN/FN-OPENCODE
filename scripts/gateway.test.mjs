import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createGateway, patchUI, patchSettings, stripPrefix, PREFIX, UI_SHA256 } from '../opencode-fnos/app/gateway/server.mjs'

test('gateway accepts only its declared prefix', () => {
  assert.equal(stripPrefix(PREFIX + '/global/event?x=1'), '/global/event?x=1')
  assert.equal(stripPrefix('/app/opencode-fnos-other/'), null)
  assert.equal(stripPrefix(PREFIX + '/../private'), null)
})

test('pinned official embedded UI supports router and truthful version adaptation', () => {
  const binary = fs.readFileSync(new URL('../opencode-fnos/app/bin/opencode', import.meta.url))
  const prefix = Buffer.from('const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/angular-html-DgL0RwuR.js","asse')
  let offset = 0, found
  while ((offset = binary.indexOf(prefix, offset)) >= 0) {
    const asset = binary.subarray(offset, offset + 2740171)
    if (crypto.createHash('sha256').update(asset).digest('hex') === UI_SHA256) { found = asset; break }
    offset++
  }
  assert.ok(found, 'Official upstream UI changed; do not ship an unreviewed adapter')
  const code = patchUI(found).toString()
  assert.ok(code.includes('base:window.__FNOS_OPENCODE__.prefix'))
  assert.ok(code.includes('ll=()=>window.__FNOS_OPENCODE__.routeLocation(ag().location)'))
  assert.ok(code.includes('Btt={version:window.__FNOS_OPENCODE__.displayVersion}'))
  assert.ok(code.includes('const qtt="1.18.35"'), 'Do not falsify the upstream UI version')
  assert.throws(() => patchUI(Buffer.from('different build')), /Unsupported/)
})

test('official settings gain a real extensions tab with a pinned compatibility check',()=>{
 const binary=fs.readFileSync(new URL('../opencode-fnos/app/bin/opencode',import.meta.url))
 const prefix=Buffer.from("const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[\"assets/index-Don-ekPW.js\",\"assets/index-Bk")
 const offset=binary.indexOf(prefix)
 assert.ok(offset>=0)
 const code=patchSettings(binary.subarray(offset,offset+33910)).toString()
 assert.ok(code.includes('value:"fnos-extensions",children:"扩展"'))
 assert.ok(code.includes('return window.__FNOS_OPENCODE__.extensionsPanel()'))
 const v2prefix=Buffer.from("const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[\"assets/dialog-settings-C8957_pd.js\",\"asset")
 const v2offset=binary.indexOf(v2prefix)
 assert.ok(v2offset>=0)
 const v2=patchSettings(binary.subarray(v2offset,v2offset+60149)).toString()
 assert.ok(v2.includes('value:"fnos-extensions",children:"扩展"'))
 assert.ok(v2.includes('return window.__FNOS_OPENCODE__.extensionsPanel()'))
 assert.throws(()=>patchSettings(Buffer.from('other build')),/Unsupported/)
})

test('HTTP, SSE and WebSocket forwarding preserve auth and stream bytes', async () => {
  const auth = 'Basic ' + Buffer.from('test:private-test-password').toString('base64')
  const backend = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, auth)
    if (req.url === '/global/event') { res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write('data: first\n\n'); return }
    res.writeHead(200, {'Content-Type':'text/html'});res.end('<head></head><script src="/assets/index.js"></script>')
  })
  const sockets = new Set()
  backend.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  backend.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/pty/test/connect?ticket=abc')
    assert.equal(req.headers.authorization, auth)
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.from([0x81,2,0x6f,0x6b]))
  })
  await new Promise(resolve => backend.listen(0,'127.0.0.1',resolve))
  const gateway = createGateway({port:backend.address().port,username:'test',password:'private-test-password',version:'1.19.0-4',bootstrap:'/* bootstrap */'})
  await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${gateway.address().port}`
  const headers = {'X-Trim-Userid':'1000','X-Trim-Isadmin':'true'}
  try {
    assert.equal((await fetch(origin + PREFIX)).status,403)
    assert.equal((await fetch(origin + PREFIX,{headers:{...headers,'X-Trim-Isadmin':'false'}})).status,403)
    const page = await (await fetch(origin + PREFIX + '/', {headers})).text()
    assert.ok(page.includes(`src="${PREFIX}/_fnos/bootstrap.js"`))
    assert.ok(page.includes(`src="${PREFIX}/assets/index.js"`))
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
