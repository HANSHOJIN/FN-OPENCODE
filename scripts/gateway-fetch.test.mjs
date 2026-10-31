import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'

function environment(fetcher, extra = {}) {
  const calls=[]
  const context={URL,Request,XMLHttpRequest:class {open(){}},HTMLLinkElement:class {},HTMLScriptElement:class {},HTMLImageElement:class {},location:new URL('http://nas.local/app/opencode-fnos/'),localStorage:{getItem:()=>null},...extra}
  class FakeWorker { constructor(url, options) {this.url=url;this.options=options} }
  context.window={__FNOS_OPENCODE__:{prefix:'/app/opencode-fnos'},WebSocket:class {},Worker:FakeWorker,SharedWorker:FakeWorker,fetch:async (...args)=>{calls.push(args);return fetcher ? fetcher(...args) : 'sent'}}
  vm.runInNewContext(fs.readFileSync(new URL('../opencode-fnos/app/gateway/bootstrap.js',import.meta.url),'utf8'),context)
  return {...context,calls}
}

test('fnOS top-level WebViews install the compact mobile titlebar without an iframe', () => {
  const styles = []
  const document = {head: {append: node => styles.push(node)}, createElement: () => ({}), addEventListener() {}}
  const env = environment(undefined, {document})
  assert.equal(env.window.frameElement, undefined)
  assert.equal(styles.length, 1)
  assert.equal(styles[0].id, 'fnos-mobile-titlebar')
  assert.match(styles[0].textContent, /@media\(max-width:767px\)/)
  assert.match(styles[0].textContent, /:not\(\.order-last\)/)
  assert.match(styles[0].textContent, /height:44px!important/)
})

test('connection failures become visible after retries and disappear only on a real reconnect', () => {
  const visible = []
  const document = {addEventListener() {}, body: {append: node => visible.push(node)}, createElement: () => ({
    style: {}, setAttribute(key, value) {this[key] = value},
    replaceChildren(...nodes) {this.children = nodes},
    remove() {visible.splice(visible.indexOf(this), 1)},
  })}
  const env = environment(undefined, {document})
  const status = env.window.__FNOS_OPENCODE__.connectionStatus
  status('reconnecting', 'Timed out connecting to server', 1)
  assert.equal(visible.length, 0)
  status('reconnecting', 'Timed out connecting to server', 2)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].role, 'alert')
  assert.match(visible[0].children[0].textContent, /Timed out connecting to server/)
  status('reconnecting', '<script>not html</script>', 3)
  assert.equal(visible.length, 1)
  assert.ok(visible[0].children[0].textContent.includes('<script>not html</script>'))
  status('connected')
  assert.equal(visible.length, 0)
})

test('HTTP read fallback is scoped to the fnOS backend and keeps only supported settings', () => {
  const env = environment()
  const {readsEnabled, settingsGroups} = env.window.__FNOS_OPENCODE__
  const sdk = {scope:'local',url:'http://nas.local/app/opencode-fnos'}
  assert.equal(readsEnabled(sdk), true)
  assert.equal(readsEnabled({...sdk,scope:'remote'}), false)
  assert.equal(readsEnabled({...sdk,url:'http://other.example/app/opencode-fnos'}), false)
  assert.equal(readsEnabled({...sdk,url:'http://nas.local/'}), false)
  assert.equal(readsEnabled({}), false)
  const original=[{items:[{value:'general'},{value:'projects'},{value:'workspaces'}]},{items:[{value:'servers'},{value:'experimental'}]},{items:[{value:'providers'},{value:'models'},{value:'extensions'},{value:'fnos-updates'}]}]
  const groups=settingsGroups(original)
  assert.deepEqual(Array.from(groups.flatMap(group=>group.items.map(item=>item.value))), ['general','providers','models','extensions','fnos-updates'])
  assert.equal(original[0].items.length, 3, 'Do not mutate the upstream menu definitions')
})

test('only a cached upgrade-created empty project selection is recovered', () => {
  const env=environment()
  env.window.__FNOS_OPENCODE__.projectHistory=['shared','old-npm']
  env.window.__FNOS_OPENCODE__.retiredProjectIDs=['upgrade-empty']
  const ids=env.window.__FNOS_OPENCODE__.projectIDs
  assert.deepEqual(Array.from(ids('local',['upgrade-empty'])),['shared','old-npm'])
  assert.deepEqual(Array.from(ids('local',['custom','upgrade-empty'])),['custom','shared','old-npm'])
  const saved=['custom'],hidden=[]
  assert.equal(ids('local',saved),saved)
  assert.equal(ids('local',hidden),hidden)
  assert.deepEqual(Array.from(ids('remote',['upgrade-empty'])),['upgrade-empty'])
})

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

test('global permission switch works without a session and restores the previous policy',async()=>{
 let policy={bash:'ask',edit:'deny'},fail=false
  const env=environment(async(url,options)=>{
  assert.equal(url,'http://nas.local/app/opencode-fnos/global/config')
  if(options?.method==='PATCH'){
   const body=JSON.parse(options.body)
   assert.deepEqual(Object.keys(body),['permission'])
   if(fail)return {ok:false,status:500}
   policy=body.permission
  }
  return {ok:true,json:async()=>({permission:policy==='allow'?{'*':'allow'}:policy})}
 },{document:{addEventListener(){},createElement:()=>({setAttribute(){},style:{},remove(){}}),body:{append(){}}},setTimeout:callback=>{callback();return 0}})
 const signal=initial=>{let value=initial;return[()=>value,next=>{value=next}]}
 const controller=env.window.__FNOS_OPENCODE__.permissionController(signal)
 await new Promise(setImmediate)
 assert.equal(controller.enabled(),true)
 assert.equal(controller.accepting(),false)
 await controller.set(true)
 assert.equal(policy,'allow')
 assert.equal(controller.accepting(),true)
 const reopened=env.window.__FNOS_OPENCODE__.permissionController(signal)
 await new Promise(setImmediate)
 assert.equal(reopened.accepting(),true,'Native wildcard policies remain enabled when settings are reopened')
 fail=true
 await controller.set(false)
 assert.equal(controller.accepting(),true,'Failed saves must not falsely display a disabled policy')
 fail=false
 await controller.set(false)
 assert.deepEqual(policy,{bash:'ask',edit:'deny'})
 assert.equal(controller.accepting(),false)
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
