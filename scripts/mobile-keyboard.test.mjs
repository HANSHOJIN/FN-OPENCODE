import test from 'node:test'
import assert from 'node:assert/strict'
import {attachKeyboardInsets} from '../opencode-fnos/app/gateway/mobile-keyboard.mjs'

function fixture(previous = '') {
  class Events {
    listeners=new Map()
    addEventListener(type,fn){const list=this.listeners.get(type)??new Set();list.add(fn);this.listeners.set(type,list)}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn)}
    emit(type){for(const fn of this.listeners.get(type)??[])fn()}
  }
  class Element {isContentEditable=false;editable=false;matches(){return this.editable}}
  const win=new Events(),doc=new Events(),view=new Events(),frames=new Map()
  let value=previous,writes=0,reads=0,id=0
  Object.assign(view,{height:800,scale:1})
  const root={style:{getPropertyValue:()=>value,getPropertyPriority:()=>previous?'important':'',setProperty(_key,next){value=next;writes++},removeProperty(){value='';writes++}},get clientHeight(){reads++;return 800}}
  Object.assign(doc,{documentElement:root,activeElement:new Element()})
  Object.assign(win,{document:doc,visualViewport:view,HTMLElement:Element,requestAnimationFrame:fn=>{frames.set(++id,fn);return id},cancelAnimationFrame:frame=>frames.delete(frame)})
  return {win,doc,view,frames,reads:()=>reads,writes:()=>writes,value:()=>value,
    flush(){const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn())}}
}

test('a keyboard animation burst performs one measurement and changes style only on transitions',()=>{
  const f=fixture(),dispose=attachKeyboardInsets(f.win)
  f.flush();assert.equal(f.writes(),0)
  f.doc.activeElement.isContentEditable=true;f.view.height=480
  for(let i=0;i<100;i++){f.view.emit('resize');f.win.emit('resize');f.doc.emit('focusin')}
  assert.equal(f.frames.size,1)
  f.flush();assert.equal(f.reads(),1);assert.equal(f.writes(),1);assert.equal(f.value(),'0px')
  f.view.emit('resize');f.win.emit('resize');f.flush();assert.equal(f.writes(),1)
  f.doc.activeElement.isContentEditable=false;f.doc.emit('focusout');f.flush()
  assert.equal(f.value(),'');assert.equal(f.writes(),2)
  dispose()
})

test('pinch zoom and readonly fields do not trigger keyboard layout overrides; cleanup preserves prior styles',()=>{
  const f=fixture('8px'),dispose=attachKeyboardInsets(f.win)
  f.doc.activeElement.editable=true;f.view.height=400;f.view.scale=2;f.flush();assert.equal(f.writes(),0)
  f.view.scale=1;f.view.emit('resize');f.flush();assert.equal(f.value(),'0px')
  f.win.emit('resize');assert.equal(f.frames.size,1);dispose()
  assert.equal(f.frames.size,0);assert.equal(f.value(),'8px')
  for(const target of [f.win,f.doc,f.view])for(const listeners of target.listeners.values())assert.equal(listeners.size,0)
  f.win.emit('resize');assert.equal(f.frames.size,0)
})

test('runtimes without visualViewport retain native layout untouched',()=>{
  const f=fixture();f.win.visualViewport=undefined;attachKeyboardInsets(f.win)()
  assert.equal(f.frames.size,0);assert.equal(f.writes(),0)
})
