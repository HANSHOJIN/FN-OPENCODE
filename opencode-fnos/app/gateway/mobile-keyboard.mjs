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
