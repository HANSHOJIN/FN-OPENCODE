import crypto from 'node:crypto'

function change(text, needle, replacement, name) {
  if (text.split(needle).length !== 2) throw new Error('Upstream adapter anchor changed: ' + name)
  return text.replace(needle, replacement)
}

function verified(source, expected) {
  if (crypto.createHash('sha256').update(source).digest('hex') !== expected) throw new Error('Unsupported upstream Web UI; review the gateway adapter')
  return source.toString('utf8')
}

export function entry(source, compatibility) {
  let text = verified(source, compatibility.ui.sha256)
  text = change(text, 'e.router??ss},root:t', 'e.router??ss},base:window.__FNOS_OPENCODE__.prefix,root:t', 'router base')
  text = change(text, 'function MM(){return location.origin}', 'function MM(){return location.origin+window.__FNOS_OPENCODE__.prefix}', 'server URL')
  text = change(text, 'draftStore:gt(),version:e,openExternal', 'draftStore:gt(),version:window.__FNOS_OPENCODE__.displayVersion,openExternal', 'display version')
  // An iframe must not install an origin-wide service worker on the fnOS desktop.
  text = change(text, 'navigator.serviceWorker.register(`/sw.js`)', 'Promise.resolve()', 'iframe service worker')
  return Buffer.from(text)
}

export function resource(source, compatibility) {
  const digest = crypto.createHash('sha256').update(source).digest('hex')
  const asset = compatibility.settings.find(item => item.sha256 === digest)
  if (!asset) throw new Error('Unsupported upstream settings UI')
  let text = source.toString('utf8')
  if (asset.role === 'router') {
    text = change(text, 'yn=()=>_n().location', 'yn=()=>window.__FNOS_OPENCODE__.routeLocation(_n().location)', 'application route location')
  } else if (asset.role === 'projects') {
    text = change(text, 'e.store.usedProjectIDs[e.scope()]??[]', 'e.store.usedProjectIDs[e.scope()]??window.__FNOS_OPENCODE__.storedProjectIDs(e.scope())', 'project recovery for a new browser store')
  } else if (asset.role === 'settings-route') {
    text = change(text, 'zt={general:!0,appearance:!0', 'zt={"fnos-updates":!0,general:!0,appearance:!0', 'program update route')
  } else if (asset.role === 'settings') {
    text = change(text, 'items:[...Cs.map', 'items:[{value:`fnos-updates`,icon:J.about,label:`程序更新`},...Cs.map', 'program update navigation')
    const panel = 'd(Q.Content,{value:`about`,class:`settings-panel settings-about`'
    text = change(text, panel, 'd(Q.Content,{value:`fnos-updates`,class:`settings-panel`,get children(){return window.__FNOS_OPENCODE__.updatesPanel()}}),' + panel, 'program update panel')
  } else throw new Error('Unknown adapter resource role')
  return Buffer.from(text)
}
