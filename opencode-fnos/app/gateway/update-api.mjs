import {execFile} from 'node:child_process'
import path from 'node:path'
import {promisify} from 'node:util'
const execute=promisify(execFile)

export async function runtimeCommand(args) {
  const env={...process.env}
  delete env.OPENCODE_SERVER_PASSWORD
  delete env.OPENCODE_SERVER_USERNAME
  const {stdout}=await execute('python3',[path.join(process.env.TRIM_APPDEST,'lib/runtime.py'),...args],{env,timeout:20000,maxBuffer:512*1024})
  return JSON.parse(stdout)
}

export async function updateAPI(req,res,url,command=runtimeCommand) {
  const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
  try {
    if(req.method==='GET' && url==='/_fnos/update/status') {json(200,await command(['status']));return}
    if(req.method==='GET' && url==='/_fnos/update/releases') {json(200,await command(['check']));return}
    if(url==='/_fnos/update/request') {json(410,{error:'已取消官方内核独立更新。请下载 FN-OPENCODE 安装包，通过飞牛应用中心更新。'});return}
    json(405,{error:'不支持的更新请求。'})
  }catch {
    json(503,{error:'暂时无法查询 FN-OPENCODE 更新，请稍后重试或打开项目发布页。'})
  }
}
