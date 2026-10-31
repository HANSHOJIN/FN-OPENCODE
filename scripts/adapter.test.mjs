import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import vm from 'node:vm'
import {entry,resource,replaceAnchor} from '../opencode-fnos/app/gateway/adapter.mjs'
const compatibility=JSON.parse(fs.readFileSync(new URL('../opencode-fnos/app/gateway/compatibility.json',import.meta.url)))
const read=path=>fs.readFileSync(new URL('../.build/upstream-ui'+path,import.meta.url))
function approved(source,asset) {return {...asset,sha256:crypto.createHash('sha256').update(source).digest('hex'),size:source.length}}

test('anchor checks reject zero or multiple matches with role, path and count',()=>{
 for(const [text,count] of [['nothing',0],['target();target()',2]]){
  assert.throws(()=>replaceAnchor(text,/target\(\)/,()=>'', 'example',{stage:'patchSettings',role:'settings',path:'/asset.js'}),error=>{
   assert.equal(error.details.matches,count);assert.equal(error.details.expectedMatches,1);assert.equal(error.details.role,'settings');assert.equal(error.details.path,'/asset.js');return true
  })
 }
})

test('entry replacements preserve renamed function and factory bindings',()=>{
 const original=read(compatibility.entry)
 const source=Buffer.from(original.toString().replace(/\bUb\b/g,'ServerOriginFixture').replace('draftStore:pt()','draftStore:DraftFactoryFixture()').replace(/\bJb\b/g,'KeyboardFixture'))
 const code=entry(source,{...compatibility,ui:approved(source,compatibility.ui)}).toString()
 assert.ok(code.includes('function ServerOriginFixture(){return location.origin+window.__FNOS_OPENCODE__.prefix}'))
 assert.ok(code.includes('draftStore:DraftFactoryFixture(),version:window.__FNOS_OPENCODE__.displayVersion'))
 assert.ok(code.includes('function KeyboardFixture(){return c(()=>s(window.__FNOS_OPENCODE__.keyboardInsets())),null}'))
 assert.throws(()=>entry(source,compatibility),error=>error.details.expectedSha256===compatibility.ui.sha256&&error.details.actualSize===source.length)
})

test('settings captures its About group and icon object after minifier renaming',()=>{
 const asset=compatibility.settings.find(item=>item.role==='settings')
 const source=Buffer.from(read(asset.path).toString().replace(/\bks\b/g,'AboutArrayFixture').replace(/\bq\b/g,'IconFixture'))
 const code=resource(source,{...compatibility,settings:[approved(source,asset)]},asset.path).toString()
 assert.ok(code.includes('icon:IconFixture.about,label:`程序更新`},...AboutArrayFixture.map'))
 assert.ok(code.includes('items:[...Ts.map(t=>({...t,label:e.t(t.label)})),..._()]'), 'Leave the similarly shaped project group intact')
 const item=code.match(/\{value:`fnos-updates`,icon:IconFixture.about,label:`程序更新`\}/)[0]
 const actual=vm.runInNewContext('('+item+')',{IconFixture:{about:'approved-icon'}})
 assert.equal(actual.icon,'approved-icon')
})

test('named settings resources report expected and actual hashes instead of losing their role',()=>{
 const asset=compatibility.settings.find(item=>item.role==='router')
 assert.throws(()=>resource(Buffer.from('wrong build'),compatibility,asset.path),error=>{
  assert.equal(error.details.role,'router');assert.equal(error.details.path,asset.path);assert.equal(error.details.expectedSize,asset.size);assert.equal(error.details.actualSize,11);assert.match(error.details.actualSha256,/^[a-f0-9]{64}$/);return true
 })
})

test('connection timeout names are captured without changing idle and foreground deadlines',()=>{
 const asset=compatibility.settings.find(item=>item.role==='connection')
 const source=Buffer.from(read(asset.path).toString().replace(/\bE\b/g,'ConnectTimeoutFixture').replace(/\bD\b/g,'RetryDelayFixture').replace(/\bO\b/g,'HistoryLimitFixture'))
 const code=resource(source,{...compatibility,settings:[approved(source,asset)]},asset.path).toString()
 assert.ok(code.includes('var ConnectTimeoutFixture=30e3,RetryDelayFixture=1e3,HistoryLimitFixture=50,k=45e3,me=2e4'))
})
