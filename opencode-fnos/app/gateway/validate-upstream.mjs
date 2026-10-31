import fs from 'node:fs'
import path from 'node:path'
import {adaptHTML, patchUI, patchSettings, COMPATIBILITY} from './server.mjs'

export async function verifyEventResponse(response) {
  if (!response.ok || !String(response.headers.get('content-type')).includes('text/event-stream') || !response.body) throw new Error('Candidate event stream incompatible')
  const reader=response.body.getReader(),decoder=new TextDecoder()
  let buffer=''
  try {
    for (;;) {
      const next=await reader.read()
      if(next.done)throw new Error('Candidate event stream ended before server.connected')
      buffer+=decoder.decode(next.value,{stream:true})
      buffer=buffer.replace(/\r\n/g,'\n')
      if(buffer.length>65536)throw new Error('Candidate event handshake too large')
      let boundary
      while((boundary=buffer.indexOf('\n\n'))>=0){
        const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2)
        const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
        if(!data)continue
        if(JSON.parse(data).type!=='server.connected')throw new Error('Candidate event stream did not start with server.connected')
        return
      }
    }
  } finally {await reader.cancel()}
}

export async function validate(port, etc, version) {
  let stage='credentials'
  try {
  const read = name => fs.readFileSync(path.join(etc, 'web.' + name), 'utf8').replace(/\n$/, '')
  const authorization = 'Basic ' + Buffer.from('opencode:' + read('password')).toString('base64')
  const base = `http://127.0.0.1:${port}`
  const get = async url => {
    const response = await fetch(base + url, {headers:{authorization},signal:AbortSignal.timeout(15000),redirect:'error'})
    if (!response.ok) throw new Error('Preflight HTTP ' + response.status)
    const limit = 8*1024*1024, chunks=[]
    let size=0
    for await (const chunk of response.body) {
      size+=chunk.length
      if (size>limit) throw new Error('Preflight resource too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  stage='health'
  let healthy = false
  for (let i=0;i<30;i++) {
    try {
      const health=JSON.parse((await get('/api/info')).toString())
      if (health.version !== version || !Number.isInteger(health.pid) || health.pid <= 0) throw new Error('Candidate version mismatch')
      healthy=true;break
    } catch {await new Promise(resolve=>setTimeout(resolve,500))}
  }
  if (!healthy) throw new Error('Candidate unavailable')
  console.error('Preflight: health and version verified')
  stage='authentication'
  const denied=await fetch(base+'/api/info',{signal:AbortSignal.timeout(5000),redirect:'error'})
  await denied.body?.cancel()
  if(denied.status!==401)throw new Error('Candidate no longer enforces Web authentication')
  console.error('Preflight: authentication verified')
  stage='html'
  const html=adaptHTML((await get('/')).toString())
  stage='patchUI'
  patchUI(await get(html.entry), html.entry)
  stage='patchSettings'
  for (const item of COMPATIBILITY.settings) patchSettings(await get(item.path), item.path)
  stage='configuration'
  const config=JSON.parse((await get('/api/config')).toString())
  if (!Array.isArray(config)) throw new Error('Candidate configuration incompatible')
  console.error('Preflight: UI, settings and configuration verified')
  stage='terminal'
  const shells=JSON.parse((await get('/api/config/shell')).toString())
  if(!Array.isArray(shells))throw new Error('Candidate terminal interface incompatible')
  console.error('Preflight: terminal listing verified')
  stage='events'
  const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),10000)
  try{
    const event=await fetch(base+'/api/event',{headers:{authorization},signal:abort.signal,redirect:'error'})
    await verifyEventResponse(event)
  }finally{clearTimeout(timer);abort.abort()}
  console.error('Preflight: SSE verified')
  return true
  } catch(error) {
    error.details={stage,version,...error.details}
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fs.realpathSync(new URL(import.meta.url))) {
  const [port,etc,version]=process.argv.slice(2)
  validate(Number(port),etc,version).catch(error=>{
    console.error('FNOS_PREFLIGHT '+JSON.stringify({time:new Date().toISOString(),...error.details,message:error.message}))
    process.exitCode=1
  })
}
