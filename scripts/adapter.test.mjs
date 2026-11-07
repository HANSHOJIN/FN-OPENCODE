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
 const text=original.toString()
 const origin=text.match(/function ([\w$]+)\(\)\{return location\.origin\}/)[1]
 const draft=text.match(/draftStore:([\w$]+)\(\),version:/)[1]
 const keyboard=text.match(/function ([\w$]+)\(\)\{return ([\w$]+)\(\(\)=>\{let [\w$]+=window\.visualViewport/)
 const source=Buffer.from(text.replace('function '+origin+'()','function ServerOriginFixture()').replace('draftStore:'+draft+'()','draftStore:DraftFactoryFixture()').replace('function '+keyboard[1]+'()','function KeyboardFixture()'))
 const code=entry(source,{...compatibility,ui:approved(source,compatibility.ui)}).toString()
 assert.ok(code.includes('function ServerOriginFixture(){return location.origin+window.__FNOS_OPENCODE__.prefix}'))
 assert.ok(code.includes('draftStore:DraftFactoryFixture(),version:window.__FNOS_OPENCODE__.displayVersion'))
 assert.match(code,/function KeyboardFixture\(\)\{return [\w$]+\(\(\)=>[\w$]+\(window\.__FNOS_OPENCODE__\.keyboardInsets\(\)\)\),null\}/)
 assert.throws(()=>entry(source,compatibility),error=>error.details.expectedSha256===compatibility.ui.sha256&&error.details.actualSize===source.length)
})

test('settings captures its About group and icon object after minifier renaming',()=>{
 const asset=compatibility.settings.find(item=>item.role==='settings')
 const text=read(asset.path).toString()
 const about=text.match(/([\w$]+)=\[\{value:`about`,icon:([\w$]+)\.about,label:`settings.tab.about`\}\]/)
 const source=Buffer.from(text.replaceAll(about[1],'AboutArrayFixture').replace(new RegExp('\\b'+about[2]+'\\b','g'),'IconFixture'))
 const code=resource(source,{...compatibility,settings:[approved(source,asset)]},asset.path).toString()
 assert.ok(code.includes('icon:IconFixture.about,label:`程序更新`},...AboutArrayFixture.map'))
 assert.equal(code.split('icon:IconFixture.about,label:`程序更新`').length-1,1,'Only add one update navigation item')
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
 const text=read(asset.path).toString()
 const names=text.match(/var ([\w$]+)=2e3,([\w$]+)=1e3,([\w$]+)=50/)
 const source=Buffer.from(text.replace(names[0],'var ConnectTimeoutFixture=2e3,RetryDelayFixture=1e3,HistoryLimitFixture=50'))
 const code=resource(source,{...compatibility,settings:[approved(source,asset)]},asset.path).toString()
 assert.match(code,/var ConnectTimeoutFixture=30e3,RetryDelayFixture=1e3,HistoryLimitFixture=50,[\w$]+=45e3,[\w$]+=2e4/)
})
