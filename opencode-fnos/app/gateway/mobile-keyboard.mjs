// Match upstream's keyboard detection, but measure at most once per animation
// frame and write the safe-area style only when its value actually changes.
export function attachKeyboardInsets(win = window) {
  const viewport = win.visualViewport
  if (!viewport) return () => {}
  const doc = win.document, root = doc.documentElement
  const property = '--safe-area-inset-bottom'
  const previous = root.style.getPropertyValue(property)
  const priority = root.style.getPropertyPriority(property)
  let frame, applied = false, disposed = false
  function restore() {
    if (!applied) return
    if (previous) root.style.setProperty(property, previous, priority)
    else root.style.removeProperty(property)
    applied = false
  }
  function sync() {
    frame = undefined
    if (disposed) return
    const active = doc.activeElement
    const editing = active instanceof win.HTMLElement && (active.isContentEditable || active.matches('input:not([readonly]), textarea:not([readonly])'))
    const keyboard = editing && win.innerHeight - viewport.height * viewport.scale > 100
    if (keyboard && !applied) {root.style.setProperty(property, '0px'); applied = true}
    else if (!keyboard) restore()
  }
  function schedule() {
    if (!disposed && frame === undefined) frame = win.requestAnimationFrame(sync)
  }
  const listeners = [[viewport,'resize'],[win,'resize'],[doc,'focusin'],[doc,'focusout']]
  for (const [target,event] of listeners) target.addEventListener(event,schedule)
  schedule()
  return () => {
    disposed = true
    if (frame !== undefined) win.cancelAnimationFrame(frame)
    for (const [target,event] of listeners) target.removeEventListener(event,schedule)
    restore()
  }
}

// Only the fnOS gateway's mobile session dock is adapted, including top-level
// WebViews where frameElement is null. Keep native
// viewport resizing; temporarily hold the expensive flex tree at its last size
// while the keyboard animates. Translate the dock without changing its box size,
// then let native layout catch up once the viewport has settled.
export function attachKeyboardMotion(win = window) {
  if (win.__FNOS_OPENCODE__?.prefix !== '/app/opencode-fnos' || !win.visualViewport || !win.CSS?.supports('translate', '0 1px')) return () => {}
  const media = win.matchMedia('(max-width: 767px)')
  if (!media.matches) return () => {}
  const doc = win.document, viewport = win.visualViewport
  const root = doc.getElementById('root')
  if (!root) return () => {}
  const saved = (node, property) => [node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]
  const restore = (node, property, [value, priority]) => {
    if (value) node.style.setProperty(property, value, priority)
    else node.style.removeProperty(property)
  }
  let dock, state, frame, quiet, deadline, disposed = false
  let height = win.innerHeight, width = win.innerWidth
  const valid = () => media.matches && Math.abs(viewport.scale - 1) < 0.01 && Math.abs(viewport.offsetTop || 0) < 1
  const connected = () => dock?.isConnected && root.contains(dock)
  function finish() {
    if (frame !== undefined) win.cancelAnimationFrame(frame)
    win.clearTimeout(quiet); win.clearTimeout(deadline)
    frame = quiet = deadline = undefined
    if (state) {
      restore(root, 'height', state.height)
      restore(state.dock, 'translate', state.translate)
      state = undefined
    }
    height = win.innerHeight; width = win.innerWidth
  }
  function begin() {
    if (state || !valid() || !connected() || Math.abs(win.innerWidth - width) > 1) return false
    // Avoid competing with another adapter's explicit translation. Read geometry
    // once at the boundary, never during the per-frame animation update.
    const translate = saved(dock, 'translate')
    if (translate[0] && translate[0] !== 'none') return false
    const rect = root.getBoundingClientRect()
    if (Math.abs(rect.height - height) > Math.max(160, height * 0.6)) return false
    state = {height: saved(root, 'height'), translate, dock, base: height}
    root.style.setProperty('height', height + 'px', 'important')
    // A hard deadline also releases the freeze if a WebView never settles.
    deadline = win.setTimeout(finish, 1000)
    return true
  }
  function draw() {
    frame = undefined
    if (disposed || !state) return
    if (!valid() || !connected() || Math.abs(win.innerWidth - width) > 1) return finish()
    const delta = win.innerHeight - state.base
    // Ignore tiny viewport rounding changes; don't touch the input/caret/scroll.
    const next = `0 ${Math.round(delta)}px`
    if (state.last !== next) {
      state.dock.style.setProperty('translate', next, 'important')
      state.last = next
    }
  }
  function resize() {
    if (disposed) return
    if (!valid() || Math.abs(win.innerWidth - width) > 1) return finish()
    if (Math.abs(win.innerHeight - height) < 1 && !state) return
    if (!connected() || (!state && !begin())) { height = win.innerHeight; return }
    win.clearTimeout(quiet)
    quiet = win.setTimeout(finish, 120)
    if (frame === undefined) frame = win.requestAnimationFrame(draw)
  }
  function focus(event) {
    // Dialogs, search boxes, new-session layouts and readonly inputs keep the
    // upstream behavior. No browser-wide scrollIntoView interception.
    const active = event.target
    if (!(active instanceof win.HTMLElement) || !(active.isContentEditable || active.matches('input:not([readonly]), textarea:not([readonly])'))) return
    const next = active.closest('[data-component="session-composer-dock"]')
    finish()
    dock = next
    if (connected() && begin()) quiet = win.setTimeout(finish, 600)
  }
  function pointer(event) {
    if (!dock?.contains(event.target)) { finish(); dock = undefined }
  }
  function hidden() { if (doc.hidden) { finish(); dock = undefined } }
  const listeners = [
    [win, 'resize', resize], [viewport, 'resize', resize], [viewport, 'scroll', finish],
    [win, 'orientationchange', finish], [doc, 'focusin', focus], [doc, 'pointerdown', pointer],
    [doc, 'visibilitychange', hidden], [win, 'pagehide', finish], [media, 'change', finish],
  ]
  for (const [target, event, fn] of listeners) target.addEventListener(event, fn)
  return () => {
    disposed = true
    for (const [target, event, fn] of listeners) target.removeEventListener(event, fn)
    finish(); dock = undefined
  }
}
