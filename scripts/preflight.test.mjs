import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyEventResponse} from '../opencode-fnos/app/gateway/validate-upstream.mjs'

function response(chunks){
 const bytes=chunks.map(text=>new TextEncoder().encode(text))
 return new Response(new ReadableStream({start(controller){for(const chunk of bytes)controller.enqueue(chunk);controller.close()}}),{headers:{'Content-Type':'text/event-stream'}})
}
test('preflight waits through comments and split CRLF for the real handshake',async()=>{
 await verifyEventResponse(response([': warmup\r','\n\r','\n','data: {"type":"server.','connected","data":{}}\r','\n\r','\n']))
})
test('HTTP success and nonempty comments alone do not prove the application can connect',async()=>{
 await assert.rejects(verifyEventResponse(response([': keepalive\n\n'])),/ended before server.connected/)
 await assert.rejects(verifyEventResponse(response(['data: {"type":"wrong-event"}\n\n'])),/did not start/)
 await assert.rejects(verifyEventResponse(new Response('{}',{headers:{'Content-Type':'application/json'}})),/incompatible/)
})
