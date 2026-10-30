import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {updateAPI} from '../opencode-fnos/app/gateway/update-api.mjs'

test('update API rejects cross-origin, unexpected fields and executable input before spawning',async()=>{
  const calls=[], token='a'.repeat(64)
  const server=http.createServer((req,res)=>updateAPI(req,res,req.url,async args=>{calls.push(args);return {phase:'queued'}},token))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const send=(body,headers={})=>fetch(base+'/_fnos/update/request',{method:'POST',headers:{'Content-Type':'application/json','X-FNOS-Update-Token':token,...headers},body:JSON.stringify(body)})
  try{
    assert.equal((await send({action:'apply',version:'1.19.5'},{Origin:'https://foreign.example','Sec-Fetch-Site':'cross-site'})).status,403)
    for(const headers of [{'X-FNOS-Update-Token':''},{'X-FNOS-Update-Token':'b'.repeat(64)},{Origin:'null'},{Origin:'invalid'}]) {
      assert.equal((await send({action:'apply',version:'1.19.5'},headers)).status,403)
    }
    assert.equal((await send({action:'apply',version:'1.2.3;echo secret'})).status,400)
    assert.equal((await send({action:'apply',version:'1.19.5',command:'sh'})).status,400)
    assert.equal(calls.length,0)
    assert.equal((await send({action:'apply',version:'1.19.5'},{Origin:'http://nas.example:5666','Sec-Fetch-Site':'same-origin'})).status,202)
    assert.deepEqual(calls,[['apply','1.19.5']])
    assert.equal((await send({action:'rollback'})).status,202)
    assert.deepEqual(calls[1],['rollback'])
  }finally{server.closeAllConnections();server.close()}
})
