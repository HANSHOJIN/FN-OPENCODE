/* Runs before upstream modules; keep upstream router and requests under fnOS. */
(() => {
  const prefix = window.__FNOS_OPENCODE__.prefix
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
  if (window.frameElement) import(prefix + '/_fnos/window-theme.js')
    .then(module => module.applyWindowTheme()).catch(() => {})
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
