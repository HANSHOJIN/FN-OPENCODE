import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'

function environment() {
  const calls=[]
  const context={URL,Request,XMLHttpRequest:class {open(){}},HTMLLinkElement:class {},HTMLScriptElement:class {},HTMLImageElement:class {},location:new URL('http://nas.local/app/opencode-fnos/'),localStorage:{getItem:()=>null}}
  class FakeWorker { constructor(url, options) {this.url=url;this.options=options} }
  context.window={__FNOS_OPENCODE__:{prefix:'/app/opencode-fnos'},WebSocket:class {},Worker:FakeWorker,SharedWorker:FakeWorker,fetch:async (...args)=>{calls.push(args);return 'sent'}}
  vm.runInNewContext(fs.readFileSync(new URL('../opencode-fnos/app/gateway/bootstrap.js',import.meta.url),'utf8'),context)
  return {...context,calls}
}

test('unnamed fnOS global projects use the default label without renaming directories or custom projects',()=>{
 const env=environment(),server={type:'http',http:{url:'http://nas.local/app/opencode-fnos'}}
 const project={id:'global',worktree:'/home/app/.npm',expanded:true}
 const label=env.window.__FNOS_OPENCODE__.projectMetadata
 assert.equal(label(project,server).name,'默认项目')
 assert.equal(label(project,server).worktree,project.worktree)
 assert.equal(project.name,undefined)
 const named={...project,name:'我的项目'},git={id:'git-id',worktree:'/projects/demo'}
 assert.equal(label(named,server),named)
 assert.equal(label(git,server),git)
 assert.equal(label(project,{type:'http',http:{url:'https://other-server.example'}}),project)
})
test('already prefixed SDK Request keeps its original non-streaming body',async()=>{
 const env=environment()
 const request=new Request('http://nas.local/app/opencode-fnos/session/test/prompt_async',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hello'}]})})
 await env.window.fetch(request,{signal:request.signal})
 assert.equal(env.calls[0][0],request)
 assert.deepEqual(await env.calls[0][0].json(),{parts:[{type:'text',text:'hello'}]})
})
test('root Request rewrite buffers bytes and preserves request options',async()=>{
 const env=environment()
 const request=new Request('http://nas.local/session/test/prompt_async',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-opencode-directory':'/test'},body:'{"text":"hello"}'})
 await env.window.fetch(request)
 const [url,init]=env.calls[0]
 assert.equal(url,'http://nas.local/app/opencode-fnos/session/test/prompt_async')
 assert.equal(Object.prototype.toString.call(init.body),'[object ArrayBuffer]')
 assert.equal(new TextDecoder().decode(init.body),'{"text":"hello"}')
 assert.equal(init.headers.get('x-opencode-directory'),'/test')
 assert.equal(init.credentials,'include')
})
test('external Request is forwarded intact',async()=>{
 const env=environment(),request=new Request('https://example.invalid/endpoint',{method:'POST',body:'hello'})
 await env.window.fetch(request)
 assert.equal(env.calls[0][0],request)
})
test('Markdown, diff and shared worker URLs remain inside the gateway',()=>{
 const env=environment()
 for(const name of ['Worker','SharedWorker']){
  const worker=new env.window[name]('/assets/markdown.worker-Bu_Dc9RP.js',{type:'module'})
  assert.equal(worker.url,'http://nas.local/app/opencode-fnos/assets/markdown.worker-Bu_Dc9RP.js')
  assert.equal(worker.options.type,'module')
  assert.equal(new env.window[name]('/app/opencode-fnos/assets/worker.js').url,'http://nas.local/app/opencode-fnos/assets/worker.js')
  assert.equal(new env.window[name]('blob:http://nas.local/example').url,'blob:http://nas.local/example')
 }
})

test('application locations are relative to the gateway base and remain reactive',()=>{
 const env=environment(),location={pathname:'/app/opencode-fnos/new-session',search:'?draftId=test',query:{draftId:'test'}}
 const mapped=env.window.__FNOS_OPENCODE__.routeLocation(location)
 assert.equal(mapped.pathname,'/new-session')
 assert.equal(mapped.search,'?draftId=test')
 assert.equal(mapped.query,location.query)
 assert.equal(env.window.__FNOS_OPENCODE__.routeLocation(location),mapped)
 location.pathname='/app/opencode-fnos/server/test/session/123'
 assert.equal(mapped.pathname,'/server/test/session/123')
 location.pathname='/app/opencode-fnos/'
 assert.equal(mapped.pathname,'/')
 location.pathname='/app/opencode-fnos-other/'
 assert.equal(mapped.pathname,location.pathname)
})
