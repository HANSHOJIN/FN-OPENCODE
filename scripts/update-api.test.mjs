import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {updateAPI} from '../opencode-fnos/app/gateway/update-api.mjs'

test('package update API exposes read-only status/check and never dispatches retired mutations',async()=>{
  const calls=[]
  const server=http.createServer((req,res)=>updateAPI(req,res,req.url,async args=>{calls.push(args);return {mode:'fpk'}}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  try{
    for(const body of [{action:'apply',version:'2.2.7'},{action:'rollback'},{command:'sh',version:';echo secret'}]){
      assert.equal((await fetch(base+'/_fnos/update/request',{method:'POST',body:JSON.stringify(body)})).status,410)
    }
    assert.deepEqual(calls,[])
    assert.equal((await fetch(base+'/_fnos/update/status')).status,200)
    assert.equal((await fetch(base+'/_fnos/update/releases')).status,200)
    assert.deepEqual(calls,[['status'],['check']])
    assert.equal((await fetch(base+'/_fnos/update/releases',{method:'POST'})).status,405)
    assert.equal(calls.length,2)
  }finally{server.closeAllConnections();server.close()}
})
