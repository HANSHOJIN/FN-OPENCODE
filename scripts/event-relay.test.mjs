import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {createEventRelay} from '../opencode-fnos/app/gateway/event-relay.mjs'
import {relayEvents} from '../opencode-fnos/app/gateway/event-transport.mjs'

async function fixture(options = {}) {
  const feeds = new Set()
  const initial='data: {"type":"server.connected","data":{}}\n\n'
  const backend=http.createServer((req,res)=>{
    assert.equal(req.url,'/api/event')
    assert.equal(req.headers.authorization,'Basic private-fixture')
    res.writeHead(200,{'Content-Type':'text/event-stream'})
    res.write(initial);feeds.add(res);res.once('close',()=>feeds.delete(res))
  })
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))
  const relay=createEventRelay({port:backend.address().port,authorization:'Basic private-fixture',pollMs:5,...options})
  const server=http.createServer((req,res)=>{if(!relay.handle(req,res,req.url,req.headers['x-test-owner']??'one')){res.writeHead(404);res.end()}})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  return {endpoint:`http://127.0.0.1:${server.address().port}/_fnos/events`,initial,
    emit:chunk=>feeds.forEach(feed=>feed.write(chunk)),
    close:()=>{relay.close();server.closeAllConnections();backend.closeAllConnections();server.close();backend.close()}}
}

test('a buffering mobile transport receives real ordered events through finite responses',async()=>{
  const f=await fixture()
  const abort=new AbortController()
  let requests=0
  const completedFetch=async(...args)=>{
    requests++
    const response=await fetch(...args)
    // Model a relay/WebView that exposes no bytes until HTTP EOF.
    return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers})
  }
  try {
    const response=await relayEvents(new Request('http://fixture/api/event',{signal:abort.signal}),completedFetch,f.endpoint)
    assert.match(response.headers.get('content-type'),/text\/event-stream/)
    const reader=response.body.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value),f.initial)
    // Empty long-poll responses must not leave the stream's reader permanently pending.
    await new Promise(resolve=>setTimeout(resolve,30))
    const actual='data: '+JSON.stringify({type:'message.part.updated',data:{text:'你好 🌍'}})+'\n\n'
    const next=reader.read();f.emit(Buffer.from(actual))
    assert.equal(new TextDecoder().decode((await next).value),actual)
    assert.ok(requests>=3)
    const pending=reader.read();abort.abort()
    await assert.rejects(pending)
    await reader.cancel().catch(()=>{})
  } finally {abort.abort();f.close()}
})

test('event cursor replay, ownership, invalid cursors and subscription limits are enforced',async()=>{
  const f=await fixture({maxClients:1})
  try {
    const first=await(await fetch(f.endpoint)).json()
    assert.equal(first.chunks[0].seq,1)
    assert.equal(Buffer.from(first.chunks[0].data,'base64').toString(),f.initial)
    const same=await(await fetch(f.endpoint+'?stream='+first.stream+'&after=0')).json()
    assert.deepEqual(same,first,'A response lost in transit can be replayed until acknowledged')
    assert.equal((await fetch(f.endpoint+'?stream='+first.stream+'&after=0',{headers:{'x-test-owner':'other'}})).status,404)
    assert.equal((await fetch(f.endpoint+'?stream='+first.stream+'&after=99')).status,409)
    assert.equal((await fetch(f.endpoint+'?after=-1')).status,400)
    assert.equal((await fetch(f.endpoint)).status,503)
    const ack=await(await fetch(f.endpoint+'?stream='+first.stream+'&after=1')).json()
    assert.deepEqual(ack.chunks,[])
    assert.equal((await fetch(f.endpoint+'?stream='+first.stream+'&after=0')).status,409)
  } finally {f.close()}
})

test('overflow fails visibly instead of dropping events and fabricating a live connection',async()=>{
  const f=await fixture({maxBytes:100})
  try {
    const first=await(await fetch(f.endpoint)).json()
    f.emit(Buffer.alloc(200,120))
    await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal((await fetch(f.endpoint+'?stream='+first.stream+'&after='+first.cursor)).status,503)
  } finally {f.close()}
})

test('browser rejects gaps and backend failures instead of masking a disconnected stream',async()=>{
  const headers={'Content-Type':'application/json'}
  const request=new Request('http://fixture/api/event')
  await assert.rejects(relayEvents(request,async()=>new Response('',{status:503}),'http://fixture/_fnos/events'),/HTTP 503/)
  await assert.rejects(relayEvents(request,async()=>new Response(JSON.stringify({stream:'a'.repeat(32),cursor:2,chunks:[{seq:2,data:'eA=='}]}),{headers}),'http://fixture/_fnos/events'),/sequence gap/)
})

test('inactive subscriptions expire and release their connection budget',async()=>{
  const f=await fixture({maxClients:1,idleMs:15})
  try {
    const first=await(await fetch(f.endpoint)).json()
    await new Promise(resolve=>setTimeout(resolve,45))
    assert.equal((await fetch(f.endpoint+'?stream='+first.stream+'&after='+first.cursor)).status,404)
    assert.equal((await fetch(f.endpoint)).status,200)
  } finally {f.close()}
})

test('a canceled navigation never creates a live-looking stream when a WebView ignores fetch abort',async()=>{
  const abort=new AbortController();abort.abort(new Error('Page closed'))
  const data={stream:'a'.repeat(32),cursor:1,chunks:[{seq:1,data:Buffer.from('data: {"type":"server.connected"}\n\n').toString('base64')}]}
  const ignoresAbort=async()=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
  await assert.rejects(relayEvents(new Request('http://fixture/api/event',{signal:abort.signal}),ignoresAbort,'http://fixture/_fnos/events'),/Page closed/)
})

test('a new subscription after network failure starts with the real handshake and a fresh cursor',async()=>{
  const f=await fixture()
  try {
    let fail=false
    const unstable=async(...args)=>{if(fail)throw new TypeError('Network disconnected');return fetch(...args)}
    const first=await relayEvents(new Request('http://fixture/api/event'),unstable,f.endpoint)
    const reader=first.body.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value),f.initial)
    fail=true
    await assert.rejects(reader.read(),/Network disconnected/)
    const restored=await relayEvents(new Request('http://fixture/api/event'),fetch,f.endpoint)
    const next=restored.body.getReader()
    assert.equal(new TextDecoder().decode((await next.read()).value),f.initial)
    await next.cancel()
  } finally {f.close()}
})
