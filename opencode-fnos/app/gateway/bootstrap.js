/* Runs before upstream modules; keep upstream router and requests under fnOS. */
(() => {
  const prefix = window.__FNOS_OPENCODE__.prefix
  window.__FNOS_OPENCODE__.keyboardInsets = () => {
    let disposed = false, cleanup
    import(prefix + '/_fnos/mobile-keyboard.js').then(module => {
      if (!disposed) cleanup = module.attachKeyboardInsets()
    }).catch(() => {})
    return () => {disposed = true; cleanup?.()}
  }
  // Initial HTTP reads must not wait for SSE. Preserve the native connection
  // status for message generation, live events and reconnect reconciliation.
  window.__FNOS_OPENCODE__.readsEnabled = sdk => {
    try {
      const url = new URL(sdk.url)
      return sdk.scope === 'local' && url.origin === location.origin && url.pathname.replace(/\/$/, '') === prefix
    } catch { return false }
  }
  window.__FNOS_OPENCODE__.settingsGroups = groups => groups.map(group => ({
    ...group, items: group.items.filter(item => !['projects', 'workspaces', 'servers', 'experimental'].includes(item.value)),
  })).filter(group => group.items.length)
  let connectionNotice
  window.__FNOS_OPENCODE__.connectionStatus = (status, error, attempt = 0) => {
    if (status === 'connected') {
      connectionNotice?.remove()
      connectionNotice = undefined
      return
    }
    if (attempt < 2 || !document.body) return
    if (!connectionNotice) {
      connectionNotice = document.createElement('div')
      connectionNotice.setAttribute('role', 'alert')
      connectionNotice.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:12px;border:1px solid #777;border-radius:8px;background:#242424;color:#fff;font:14px sans-serif;white-space:pre-wrap;overflow-wrap:anywhere'
      document.body.append(connectionNotice)
    }
    const message = document.createElement('span')
    message.textContent = '实时连接尚未建立，项目与会话列表仍可读取；消息实时更新暂不可用。\n' + String(error || '连接中断').slice(0, 220) + '\n'
    const retry = document.createElement('button')
    retry.textContent = '重新连接'
    retry.onclick = () => window.location.reload()
    connectionNotice.replaceChildren(message, retry)
  }
  // Recover the NAS project list when a mobile WebView starts with fresh storage.
  // An explicit saved empty list still wins, so hiding projects stays effective.
  window.__FNOS_OPENCODE__.storedProjectIDs = scope => scope === 'local'
    ? [...(window.__FNOS_OPENCODE__.projectHistory || [])] : []
  window.__FNOS_OPENCODE__.projectIDs = (scope, saved) => {
    if (saved === undefined) return window.__FNOS_OPENCODE__.storedProjectIDs(scope)
    if (scope !== 'local') return saved
    const retired = new Set(window.__FNOS_OPENCODE__.retiredProjectIDs || [])
    if (!saved.some(id => retired.has(id))) return saved
    return [...new Set([...saved.filter(id => !retired.has(id)), ...window.__FNOS_OPENCODE__.storedProjectIDs(scope)])]
  }
  window.__FNOS_OPENCODE__.attachmentDigest = async blob => {
    const module = await import(prefix + '/_fnos/attachment-digest.js')
    return module.attachmentDigest(blob)
  }
  // The upstream settings controller only works for persisted sessions. This
  // controller exposes the native server's global default policy on any page.
  window.__FNOS_OPENCODE__.permissionController = signal => {
    const [checked, setChecked] = signal(false)
    const [ready, setReady] = signal(false)
    const [saving, setSaving] = signal(false)
    let previous = 'ask'
    const allowsByDefault = policy => policy === 'allow' || (policy && typeof policy === 'object' && policy['*'] === 'allow')
    const notice = text => {
      const element = document.createElement('div')
      element.setAttribute('role', 'status')
      element.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:420px;padding:12px 16px;border:1px solid #555;border-radius:8px;background:#242424;color:#eee;font:14px sans-serif'
      element.textContent = text
      document.body.append(element)
      setTimeout(() => element.remove(), 8000)
    }
    const config = async value => {
      const options = value === undefined ? undefined : {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({permission:value})}
      const response = await window.fetch(prefix + '/global/config', options)
      if (!response.ok) throw new Error('Permission settings HTTP ' + response.status)
      return response.json()
    }
    config().then(value => {
      if (!allowsByDefault(value.permission)) previous = value.permission ?? 'ask'
      setChecked(Boolean(allowsByDefault(value.permission)))
      setReady(true)
    }).catch(() => notice('无法读取自动审批设置，请检查应用连接后重新打开设置。'))
    return {
      accepting: checked,
      enabled: () => ready() && !saving(),
      async set(value) {
        if (!ready() || saving()) return
        setSaving(true)
        try {
          await config(value ? 'allow' : previous)
          setChecked(value)
          notice(value ? '已开启全局默认自动批准；项目单独设置的权限规则仍优先。' : '已恢复全局审批策略。')
        } catch { notice('自动审批设置保存失败，请检查应用连接后重试。') }
        finally { setSaving(false) }
      },
    }
  }
  if (window.frameElement) {
    // fnOS already places this iframe below its native mobile header. Do not
    // count the outer WebView's top safe area again inside the app titlebar.
    // Keep standalone browsers and the bottom titlebar's safe area unchanged.
    const style = document.createElement('style')
    style.id = 'fnos-mobile-titlebar'
    style.textContent = '@media(max-width:767px){[data-slot="titlebar-v2"]:not(.order-last){height:44px!important;min-height:44px!important;padding-top:8px!important;padding-bottom:8px!important;box-sizing:border-box}}'
    document.head.append(style)
    import(prefix + '/_fnos/window-theme.js')
      .then(module => module.applyWindowTheme()).catch(() => {})
  }
  window.__FNOS_OPENCODE__.projectMetadata = (project, server) => {
    if (project.id !== 'global' || project.name) return project
    try {
      const url = new URL(server.http.url)
      if (url.origin !== location.origin || url.pathname.replace(/\/$/, '') !== prefix) return project
      return { ...project, name: '默认项目' }
    } catch { return project }
  }
  // Application path classification expects paths relative to the router base.
  const locations = new WeakMap()
  window.__FNOS_OPENCODE__.routeLocation = (value) => {
    if (!locations.has(value)) locations.set(value, new Proxy(value, {
      get(target, key) {
        const result = Reflect.get(target, key)
        if (key !== 'pathname') return result
        return result === prefix ? '/' : result.startsWith(prefix + '/') ? result.slice(prefix.length) : result
      },
    }))
    return locations.get(value)
  }
  window.__FNOS_OPENCODE__.extensionsPanel = () => {
    const root = document.createElement('div')
    root.textContent = '正在加载扩展…'
    import(prefix + '/_fnos/extensions.js').then(module => module.mount(root)).catch(() => { root.textContent = '扩展页面加载失败，请重新打开设置。' })
    return root
  }
  window.__FNOS_OPENCODE__.updatesPanel = () => {
    const root = document.createElement('div')
    root.textContent = '正在加载程序更新…'
    import(prefix + '/_fnos/updates.js').then(module => module.mount(root)).catch(() => { root.textContent = '更新页面加载失败，请重新打开设置。' })
    return root
  }
  const map = (input) => {
    const url = new URL(input, location.href)
    if (url.host === location.host && !url.pathname.startsWith(prefix + '/') && url.pathname !== prefix) {
      url.pathname = prefix + url.pathname
    }
    return url.href
  }
  // Tab strips use plain anchors. Normalize before Solid Router's delegated
  // click handler decides whether the link belongs to this application's base.
  if (typeof document !== 'undefined') document.addEventListener('click', event => {
    const anchor = event.target?.closest?.('a[href]')
    if (!anchor) return
    const target = map(anchor.href)
    if (target !== anchor.href) anchor.href = target
  }, true)
  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (input, options) => {
    const targetURL = new URL(map(input instanceof Request ? input.url : input))
    if (targetURL.origin === location.origin && targetURL.pathname === prefix + '/api/event' && (options?.method || (input instanceof Request ? input.method : 'GET')) === 'GET') {
      const {relayEvents} = await import(prefix + '/_fnos/event-transport.js')
      return relayEvents(new Request(targetURL, input instanceof Request ? new Request(input, options) : options), nativeFetch, location.origin + prefix + '/_fnos/events')
    }
    if (!(input instanceof Request)) return nativeFetch(map(input), options)
    const target = map(input.url)
    // Request-as-RequestInit turns a JSON body into a streaming upload, which
    // Chromium cannot send over the HTTP/1 paths used by the NAS gateway.
    if (target === input.url) return nativeFetch(input, options)
    const request = new Request(input, options)
    const init = {
      method: request.method, headers: request.headers,
      credentials: request.credentials, cache: request.cache,
      redirect: request.redirect, referrer: request.referrer,
      referrerPolicy: request.referrerPolicy, integrity: request.integrity,
      keepalive: request.keepalive, signal: request.signal,
    }
    if (request.mode !== 'navigate') init.mode = request.mode
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null) {
      init.body = await request.arrayBuffer()
    }
    return nativeFetch(target, init)
  }
  const nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function(method, url, ...args) { return nativeOpen.call(this, method, map(url), ...args) }
  const NativeSocket = window.WebSocket
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) { super(map(url), protocols) }
  }
  for (const name of ['Worker', 'SharedWorker']) {
    const NativeWorker = window[name]
    if (!NativeWorker) continue
    window[name] = class extends NativeWorker {
      constructor(url, options) { super(map(url), options) }
    }
  }
  // Vite preload links and dynamically created media are not fetch() calls.
  for (const [type, property] of [[HTMLLinkElement, 'href'], [HTMLScriptElement, 'src'], [HTMLImageElement, 'src']]) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, property)
    if (!descriptor?.set) continue
    Object.defineProperty(type.prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, map(value)) } })
  }
  // Avoid reusing a root-only server URL saved by an earlier UI on this origin.
  const key = 'opencode.settings.dat:defaultServerUrl'
  try {
    const saved = localStorage.getItem(key)
    if (saved && new URL(saved, location.href).origin === location.origin) localStorage.setItem(key, location.origin + prefix)
  } catch {}
})()
