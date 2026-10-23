import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {updateAPI} from '../opencode-fnos/app/gateway/update-api.mjs'

test('update API rejects cross-origin, unexpected fields and executable input before spawning',async()=>{
  const calls=[]
  const server=http.createServer((req,res)=>updateAPI(req,res,req.url,async args=>{calls.push(args);return {phase:'queued'}}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const send=(body,headers={})=>fetch(base+'/_fnos/update/request',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
  try{
    assert.equal((await send({action:'apply',version:'1.19.5'},{Origin:'https://foreign.example'})).status,403)
    assert.equal((await send({action:'apply',version:'1.2.3;echo secret'})).status,400)
    assert.equal((await send({action:'apply',version:'1.19.5',command:'sh'})).status,400)
    assert.equal(calls.length,0)
    assert.equal((await send({action:'apply',version:'1.19.5'},{Origin:base})).status,202)
    assert.deepEqual(calls,[['apply','1.19.5']])
    assert.equal((await send({action:'rollback'})).status,202)
    assert.deepEqual(calls[1],['rollback'])
  }finally{server.closeAllConnections();server.close()}
})
