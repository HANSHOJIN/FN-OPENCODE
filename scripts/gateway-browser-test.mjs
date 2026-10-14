// Run with Node, open http://127.0.0.1:4188, and click both send buttons.
// Both cases must return the JSON body through the prefix over HTTP/1.
import http from 'node:http'
import fs from 'node:fs'
const prefix='/app/opencode-fnos'
let config={mcp:{},plugin:[]};
http.createServer((req,res)=>{
 if(req.url===prefix+'/_fnos/extensions.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(new URL('../opencode-fnos/app/gateway/extensions.mjs',import.meta.url)));return}
 if(req.url===prefix+'/skill'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{name:'browser-test-skill',description:'Local fixture only',location:'/test/skills/demo/SKILL.md'}]));return}
 if(req.url===prefix+'/global/config'){res.setHeader('Content-Type','application/json');if(req.method==='PATCH'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{config={...config,...JSON.parse(body)};res.end(JSON.stringify(config))})}else res.end(JSON.stringify(config));return}
 if(req.url?.startsWith(prefix+'/assets/')){
  const asset=req.url.split('?')[0].slice(prefix.length+1)
  const file=new URL('../.build/browser-assets/'+asset,import.meta.url)
  if(!fs.existsSync(file)){res.writeHead(404);res.end('Missing worker fixture');return}
  res.setHeader('Content-Type',asset.endsWith('.wasm')?'application/wasm':'text/javascript; charset=utf-8')
  res.end(fs.readFileSync(file));return
 }
 if(req.url===prefix+'/bootstrap.js'){
  res.setHeader('Content-Type','text/javascript; charset=utf-8')
  res.end('window.__FNOS_OPENCODE__={prefix:'+JSON.stringify(prefix)+'};'+fs.readFileSync(new URL('../opencode-fnos/app/gateway/bootstrap.js',import.meta.url),'utf8'));return
 }
 if(req.method==='POST'){
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,body:Buffer.concat(chunks).toString(),path:req.url}))});return
 }
 res.setHeader('Content-Type','text/html; charset=utf-8')
 res.end(`<!doctype html><meta charset="utf-8"><title>fnOS browser regression</title><script src="${prefix}/bootstrap.js"></script><h1>Browser regression</h1><button id="prefixed">Send prefixed SDK Request</button><button id="root">Send root SDK Request</button><button id="worker">Render Markdown using official worker</button><button id="extensions">Open extensions</button><pre id="result">Not run</pre><div id="extensions-root"></div><div id="markdown"></div><script>document.getElementById('extensions').onclick=()=>document.getElementById('extensions-root').replaceChildren(window.__FNOS_OPENCODE__.extensionsPanel());for(const id of ['prefixed','root'])document.getElementById(id).onclick=async()=>{const result=document.getElementById('result');try{const request=new Request(location.origin+(id==='prefixed'?'${prefix}':'')+'/echo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'fnos fetch test',case:id})});const response=await fetch(request);result.textContent='PASS '+await response.text()}catch(error){result.textContent='FAIL '+error.message;console.error(error)}};document.getElementById('worker').onclick=()=>{const result=document.getElementById('result');const worker=new Worker('/assets/markdown.worker-Bu_Dc9RP.js',{type:'module'});worker.onerror=()=>{result.textContent='FAIL Markdown highlighting worker failed';worker.terminate()};worker.onmessage=({data})=>{if(data.type==='parse'){document.getElementById('markdown').innerHTML=data.html;result.textContent='PASS official Markdown worker rendered headings, bold text and code';worker.terminate()}else{result.textContent='FAIL '+data.message;worker.terminate()}};worker.postMessage({type:'parse',id:1,text:'# Gateway render test\\n\\n**bold text**\\n\\n'+String.fromCharCode(96).repeat(3)+'js\\nconst answer = 42;\\n'+String.fromCharCode(96).repeat(3)})};</script>`)
}).listen(4188,'127.0.0.1',()=>console.log('Browser regression: http://127.0.0.1:4188'))
