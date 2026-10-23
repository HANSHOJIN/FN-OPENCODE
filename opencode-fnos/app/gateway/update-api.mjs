import {execFile} from 'node:child_process'
import path from 'node:path'
import {promisify} from 'node:util'
const execute=promisify(execFile)

export async function runtimeCommand(args) {
  const env={...process.env}
  delete env.OPENCODE_SERVER_PASSWORD
  delete env.OPENCODE_SERVER_USERNAME
  const {stdout}=await execute('python3',[path.join(process.env.TRIM_APPDEST,'lib/runtime.py'),...args],{env,timeout:35000,maxBuffer:128*1024})
  return JSON.parse(stdout)
}

export async function updateAPI(req,res,url,command=runtimeCommand) {
  const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
  try {
    if(req.method==='GET' && url==='/_fnos/update/status') {json(200,await command(['status']));return}
    if(req.method==='GET' && url==='/_fnos/update/releases') {json(200,await command(['check']));return}
    if(req.method!=='POST' || url!=='/_fnos/update/request'){json(405,{error:'不支持的更新请求。'});return}
    // fnOS identity is validated by the gateway; also reject browser CSRF.
    const origin=req.headers.origin
    if(req.headers['sec-fetch-site']==='cross-site' || (origin && new URL(origin).host!==req.headers.host)) {json(403,{error:'来源不匹配。'});return}
    if(!String(req.headers['content-type']).startsWith('application/json')){json(415,{error:'请求须为 JSON。'});return}
    const chunks=[];let size=0
    for await(const part of req){size+=part.length;if(size>4096){json(413,{error:'请求过大。'});return}chunks.push(part)}
    const body=JSON.parse(Buffer.concat(chunks).toString())
    if(!body || typeof body!=='object' || Array.isArray(body))throw new Error('请求格式错误。')
    if(Object.keys(body).some(k=>!['action','version'].includes(k)))throw new Error('未知更新参数。')
    if(body.action==='apply' && typeof body.version==='string' && /^\d+\.\d+\.\d+$/.test(body.version))json(202,await command(['apply',body.version]))
    else if(body.action==='rollback' && body.version===undefined)json(202,await command(['rollback']))
    else json(400,{error:'更新操作或版本号无效。'})
  }catch(error){
    let message='更新请求失败，请检查网络及应用日志。'
    try{const result=JSON.parse(String(error.stderr||''));if(typeof result.error==='string')message=result.error}catch{}
    json(400,{error:message})
  }
}
