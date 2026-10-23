import fs from 'node:fs'
import path from 'node:path'
import {adaptHTML, patchUI, patchSettings, COMPATIBILITY} from './server.mjs'

export async function validate(port, etc, version) {
  const read = name => fs.readFileSync(path.join(etc, 'web.' + name), 'utf8').replace(/\n$/, '')
  const authorization = 'Basic ' + Buffer.from(read('username') + ':' + read('password')).toString('base64')
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
  let healthy = false
  for (let i=0;i<30;i++) {
    try {
      const health=JSON.parse((await get('/global/health')).toString())
      if (health.healthy !== true || health.version !== version) throw new Error('Candidate version mismatch')
      healthy=true;break
    } catch {await new Promise(resolve=>setTimeout(resolve,500))}
  }
  if (!healthy) throw new Error('Candidate unavailable')
  console.error('Preflight: health and version verified')
  const denied=await fetch(base+'/global/health',{signal:AbortSignal.timeout(5000),redirect:'error'})
  await denied.body?.cancel()
  if(denied.status!==401)throw new Error('Candidate no longer enforces Web authentication')
  console.error('Preflight: authentication verified')
  const html=adaptHTML((await get('/')).toString())
  patchUI(await get(html.entry))
  for (const item of COMPATIBILITY.settings) patchSettings(await get(item.path))
  const config=JSON.parse((await get('/global/config')).toString())
  if (!config || typeof config!=='object' || Array.isArray(config)) throw new Error('Candidate configuration incompatible')
  console.error('Preflight: UI, settings and configuration verified')
  const shells=JSON.parse((await get('/pty/shells')).toString())
  if(!Array.isArray(shells))throw new Error('Candidate terminal interface incompatible')
  console.error('Preflight: terminal listing verified')
  const abort=new AbortController(), timer=setTimeout(()=>abort.abort(),10000)
  try{
    const event=await fetch(base+'/global/event',{headers:{authorization},signal:abort.signal,redirect:'error'})
    if(!event.ok || !String(event.headers.get('content-type')).includes('text/event-stream'))throw new Error('Candidate event stream incompatible')
    const reader=event.body.getReader()
    try{const first=await reader.read();if(first.done || !first.value?.length)throw new Error('Candidate event stream empty')}
    finally{await reader.cancel()}
  }finally{clearTimeout(timer);abort.abort()}
  console.error('Preflight: SSE verified')
  return true
}

if (process.argv[1] && path.resolve(process.argv[1])===fs.realpathSync(new URL(import.meta.url))) {
  const [port,etc,version]=process.argv.slice(2)
  validate(Number(port),etc,version).catch(error=>{console.error(error.message);process.exitCode=1})
}
