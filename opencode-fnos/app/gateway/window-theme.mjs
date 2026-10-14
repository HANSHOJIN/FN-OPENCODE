// Optional, scoped adapter for the fnOS iframe host. No system files change.
export function applyWindowTheme(child = window) {
  let frame, host, doc
  try {
    frame = child.frameElement
    host = frame?.closest('.trim-ui__app-layout--window')
    doc = host?.ownerDocument
  } catch { return false }
  if (!host || !doc || !host.querySelector('.trim-ui__app-layout--header')) return false
  let body = frame
  while (body.parentElement && body.parentElement !== host) body = body.parentElement
  if (body.parentElement !== host) return false
  body.setAttribute('data-fnos-opencode-body', '')
  frame.setAttribute('data-fnos-opencode-frame', '')
  const key = 'data-fnos-opencode-theme'
  const styleID = 'fnos-opencode-window-theme'
  let style = doc.getElementById(styleID)
  if (!style) {
    style = doc.createElement('style')
    style.id = styleID
    doc.head.append(style)
  }
  // Update a stylesheet left by an older iframe when upgrading without
  // refreshing the fnOS desktop itself.
  style.textContent = `
      [${key}] { outline-color:var(--fnos-oc-border)!important; background:var(--fnos-oc-body)!important; }
      [${key}="dark"] { --fnos-oc-header:#0b0b0b; --fnos-oc-body:#080808; --fnos-oc-text:#dedede; --fnos-oc-hover:#292929; --fnos-oc-border:#303030; }
      [${key}="light"] { --fnos-oc-header:#f5f5f5; --fnos-oc-body:#fafafa; --fnos-oc-text:#262626; --fnos-oc-hover:#e4e4e4; --fnos-oc-border:#d6d6d6; }
      [${key}] > [data-fnos-opencode-body] {
        flex:1 1 0%!important; min-height:0!important; height:auto!important;
        overflow:hidden; background:var(--fnos-oc-body)!important;
      }
      [${key}] .trim-ui__app-layout--background { background:var(--fnos-oc-body)!important; }
      [${key}] iframe[data-fnos-opencode-frame] { display:block; width:100%; height:100%; border:0; }
      [${key}] .trim-ui__app-layout--header {
        background:var(--fnos-oc-header)!important;
        color:var(--fnos-oc-text)!important;
        height:32px!important; min-height:32px!important;
        border-bottom:1px solid var(--fnos-oc-border);
      }
      [${key}] .trim-ui__app-layout--header-title,
      [${key}] .trim-ui__app-layout--header [class*="app-layout-header-"] { color:var(--fnos-oc-text)!important; }
      [${key}] .trim-ui__app-layout--header-title { font-size:12px!important; }
      [${key}] .app-layout-header-minimize:hover,
      [${key}] .app-layout-header-maximize:hover { background:var(--fnos-oc-hover)!important; }
    `
  const root = child.document.documentElement
  const media = child.matchMedia('(prefers-color-scheme: dark)')
  const sync = () => {
    const scheme = root.getAttribute('data-color-scheme')
    host.setAttribute(key, scheme === 'dark' || (scheme !== 'light' && media.matches) ? 'dark' : 'light')
  }
  sync()
  const observer = new child.MutationObserver(sync)
  observer.observe(root, { attributes: true, attributeFilter: ['data-color-scheme'] })
  media.addEventListener('change', sync)
  child.addEventListener('pagehide', () => {
    observer.disconnect()
    media.removeEventListener('change', sync)
    host.removeAttribute(key)
    body.removeAttribute('data-fnos-opencode-body')
    frame.removeAttribute('data-fnos-opencode-frame')
  }, { once: true })
  return true
}
