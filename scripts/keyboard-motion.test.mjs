import test from 'node:test'
import assert from 'node:assert/strict'
import {attachKeyboardMotion} from '../opencode-fnos/app/gateway/mobile-keyboard.mjs'

function fixture() {
  class Events {
    listeners = new Map()
    addEventListener(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(fn) }
    removeEventListener(event, fn) { this.listeners.get(event)?.delete(fn) }
    emit(event, target) { for (const fn of this.listeners.get(event) ?? []) fn({target}) }
  }
  function style(initial = {}) {
    const values = new Map(Object.entries(initial).map(([key, value]) => [key, [value, 'important']]))
    return {getPropertyValue: key => values.get(key)?.[0] ?? '', getPropertyPriority: key => values.get(key)?.[1] ?? '',
      setProperty(key, value, priority) { values.set(key, [value, priority]) }, removeProperty(key) {values.delete(key)}}
  }
  const win = new Events(), doc = new Events(), view = new Events(), media = new Events()
  const frames = new Map(), timers = new Map()
  let id = 0, time = 0, measures = 0
  const dock = {isConnected: true, style: style(), contains: target => target === active}
  class Element {
    isContentEditable = true
    matches() { return false }
    closest() { return dock }
  }
  const active = new Element()
  const root = {style: style(), contains: node => node === dock,
    getBoundingClientRect() { measures++; return {height: Number.parseFloat(root.style.getPropertyValue('height')) || win.innerHeight} }}
  Object.assign(doc, {documentElement: root, hidden: false, getElementById: id => id === 'root' ? root : null})
  Object.assign(view, {height: 800, scale: 1, offsetTop: 0})
  Object.assign(media, {matches: true})
  Object.assign(win, {document: doc, frameElement: {}, __FNOS_OPENCODE__: {prefix: '/app/opencode-fnos'}, innerHeight: 800, innerWidth: 390, visualViewport: view,
    HTMLElement: Element, CSS: {supports: () => true}, matchMedia: () => media,
    requestAnimationFrame(fn) {frames.set(++id, fn); return id}, cancelAnimationFrame(id) {frames.delete(id)},
    setTimeout(fn, delay) {timers.set(++id, {fn, due: time + delay}); return id}, clearTimeout(id) {timers.delete(id)}})
  return {win, doc, view, media, root, dock, active, frames, timers, measures: () => measures,
    focus() {doc.emit('focusin', active)},
    resize(height) {win.innerHeight = view.height = height; win.emit('resize'); view.emit('resize')},
    flush() {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn())},
    tick(ms) {time += ms; for (const [id, timer] of [...timers]) if (timer.due <= time && timers.delete(id)) timer.fn()}}
}

test('keyboard opening holds root size, translates only the dock and releases at the final size', () => {
  const f = fixture(), dispose = attachKeyboardMotion(f.win)
  f.focus()
  assert.equal(f.root.style.getPropertyValue('height'), '800px')
  for (const height of [790, 750, 680, 600, 520, 480]) { f.resize(height); f.flush(); f.tick(16) }
  assert.equal(f.root.style.getPropertyValue('height'), '800px')
  assert.equal(f.dock.style.getPropertyValue('translate'), '0 -320px')
  assert.equal(f.measures(), 1, 'no repeated geometry reads during animation')
  f.tick(121)
  assert.equal(f.root.style.getPropertyValue('height'), '')
  assert.equal(f.dock.style.getPropertyValue('translate'), '')
  assert.equal(f.timers.size, 0)
  dispose()
})

test('keyboard closing also coalesces both resize sources and restores the normal layout', () => {
  const f = fixture(), dispose = attachKeyboardMotion(f.win)
  f.focus(); f.resize(480); f.flush(); f.tick(121)
  f.resize(520); f.resize(600)
  assert.equal(f.frames.size, 1)
  f.flush()
  assert.equal(f.root.style.getPropertyValue('height'), '480px')
  assert.equal(f.dock.style.getPropertyValue('translate'), '0 120px')
  f.resize(800); f.flush(); f.tick(121)
  assert.equal(f.root.style.getPropertyValue('height'), '')
  assert.equal(f.dock.style.getPropertyValue('translate'), '')
  dispose()
})

test('typing and composition events never freeze, scroll or schedule layout work', () => {
  const f = fixture(), dispose = attachKeyboardMotion(f.win)
  f.focus(); f.resize(480); f.flush(); f.tick(121)
  for (let i = 0; i < 100; i++) { f.doc.emit('input', f.active); f.doc.emit('compositionupdate', f.active) }
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0)
  assert.equal(f.measures(), 1)
  dispose()
})

test('orientation, pan, hidden page and unmount cancel temporary overrides and pending callbacks', () => {
  for (const cancel of [f => {f.win.innerWidth = 800; f.win.emit('resize')},
    f => {f.view.offsetTop = 20; f.view.emit('scroll')},
    f => {f.doc.hidden = true; f.doc.emit('visibilitychange')},
    f => f.win.emit('pagehide')]) {
    const f = fixture(), dispose = attachKeyboardMotion(f.win)
    f.root.style.setProperty('height', '800px', 'important')
    f.focus(); f.resize(600); f.flush(); cancel(f)
    assert.equal(f.root.style.getPropertyValue('height'), '800px')
    assert.equal(f.root.style.getPropertyPriority('height'), 'important')
    assert.equal(f.dock.style.getPropertyValue('translate'), '')
    assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0)
    dispose()
    for (const target of [f.win, f.doc, f.view, f.media])
      for (const listeners of target.listeners.values()) assert.equal(listeners.size, 0)
  }
})

test('no keyboard resize and endlessly firing resize events have bounded lifetime', () => {
  const f = fixture(), dispose = attachKeyboardMotion(f.win)
  f.focus(); f.tick(601)
  assert.equal(f.root.style.getPropertyValue('height'), '')
  f.focus()
  for (let i = 0; i < 10; i++) {f.resize(790 - i * 10); f.flush(); f.tick(100)}
  assert.equal(f.root.style.getPropertyValue('height'), '')
  assert.equal(f.timers.size, 0)
  dispose()
})

test('top-level fnOS WebViews enable motion without an iframe', () => {
  const f = fixture(); f.win.frameElement = null
  const dispose = attachKeyboardMotion(f.win)
  f.focus(); f.resize(480); f.flush()
  assert.equal(f.root.style.getPropertyValue('height'), '800px')
  assert.equal(f.dock.style.getPropertyValue('translate'), '0 -320px')
  dispose()
})

test('non-gateway, desktop, unsupported CSS, non-session fields and zoom keep native behavior', () => {
  for (const modify of [f => {delete f.win.__FNOS_OPENCODE__}, f => {f.media.matches = false},
    f => {f.win.CSS.supports = () => false}, f => {f.active.closest = () => null},
    f => {f.view.scale = 2}, f => {f.active.isContentEditable = false},
    f => {f.dock.style.setProperty('translate', '10px', 'important')}]) {
    const f = fixture(); modify(f)
    const dispose = attachKeyboardMotion(f.win)
    f.focus(); f.resize(480); f.flush()
    assert.equal(f.root.style.getPropertyValue('height'), '')
    assert.equal(f.frames.size, 0)
    dispose()
  }
})
