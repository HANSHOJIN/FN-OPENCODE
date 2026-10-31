import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
import {COMPATIBILITY,patchUI,patchSettings} from '../opencode-fnos/app/gateway/server.mjs'
const root=new URL('../.build/upstream-ui/',import.meta.url)
const checked=[]
try {
  for(const item of [{path:COMPATIBILITY.entry,role:'entry',...COMPATIBILITY.ui},...COMPATIBILITY.settings]) {
    const source=fs.readFileSync(new URL('.'+item.path,root))
    const output=item.role==='entry'?patchUI(source,item.path):patchSettings(source,item.path)
    const syntax=spawnSync(process.execPath,['--input-type=module','--check'],{input:output,encoding:'utf8'})
    if(syntax.status!==0)throw new Error('Patched module syntax failed: '+item.role+' '+item.path+' '+syntax.stderr)
    checked.push({role:item.role,path:item.path,sha256:item.sha256,size:item.size,checks:['sha256','size','unique anchors','patched syntax']})
  }
  process.stdout.write(JSON.stringify({version:COMPATIBILITY.server,passed:true,resources:checked},null,2)+'\n')
} catch(error) {
  process.stderr.write(JSON.stringify({passed:false,message:error.message,...error.details})+'\n')
  process.exitCode=1
}
