import crypto from 'node:crypto'

function problem(message, context) {
  const error = new Error(message + ' ' + JSON.stringify(context))
  error.code = 'FNOS_ADAPTER_CHECK'
  error.details = context
  return error
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function pattern(value) {
  return value instanceof RegExp ? new RegExp(value.source, value.flags.replace(/g/g, '') + 'g') : new RegExp(escape(value), 'g')
}
function one(text, value, name, context) {
  const regex = pattern(value), hits = [...text.matchAll(regex)]
  if (hits.length !== 1) throw problem('Upstream adapter anchor changed', {...context,anchor:name,matches:hits.length,expectedMatches:1})
  return hits[0]
}
export function replaceAnchor(text, value, build, name, context = {}) {
  one(text, value, name, context)
  return text.replace(pattern(value), build)
}
function verified(source, expected, context) {
  const actualSha256 = crypto.createHash('sha256').update(source).digest('hex')
  if (actualSha256 !== expected.sha256 || source.length !== expected.size) throw problem('Unsupported upstream Web UI; review the gateway adapter', {
    ...context,expectedSha256:expected.sha256,actualSha256,expectedSize:expected.size,actualSize:source.length,
  })
  return source.toString('utf8')
}

export function entry(source, compatibility, requestedPath = compatibility.entry) {
  const context = {stage:'patchUI',role:'entry',path:requestedPath}
  let text = verified(source, compatibility.ui, context)
  const edit = (value, build, name) => {text = replaceAnchor(text,value,build,name,context)}
  edit(/([\w$]+)\.router\?\?([\w$]+)\},root:([\w$]+)/,
    (_,config,fallback,root) => `${config}.router??${fallback}},base:window.__FNOS_OPENCODE__.prefix,root:${root}`, 'router base')
  edit(/function ([\w$]+)\(\)\{return location\.origin\}/,
    (_,fn) => `function ${fn}(){return location.origin+window.__FNOS_OPENCODE__.prefix}`, 'server URL')
  edit(/draftStore:([\w$]+)\(\),version:([\w$]+),openExternal/,
    (_,store) => `draftStore:${store}(),version:window.__FNOS_OPENCODE__.displayVersion,openExternal`, 'display version')
  edit(/connected:([\w$]+)\?\.sdk\.connection\.status\(\)===`connected`(?=,projectsReady:)/,
    (_,ctx) => `connected:(${ctx}?.sdk.connection.status()===\`connected\`||window.__FNOS_OPENCODE__.readsEnabled(${ctx}?.sdk))`, 'initial home reads independent of event stream')
  edit(/if\(([\w$]+)\.server\.focusedContext\(\)\?\.sdk\.connection\.status\(\)===`connected`\)return`connected`/,
    (_,home) => `if(${home}.server.focusedContext()?.sdk.connection.status()===\`connected\`||window.__FNOS_OPENCODE__.readsEnabled(${home}.server.focusedContext()?.sdk))return\`connected\``, 'initial home session list')
  edit('navigator.serviceWorker.register(`/sw.js`)', 'Promise.resolve()', 'iframe service worker')
  // The approved hash and listener shape gate the callback body. Capture the
  // component and Solid hooks instead of depending on their minified names.
  edit(/function ([\w$]+)\(\)\{return ([\w$]+)\(\(\)=>\{let ([\w$]+)=window\.visualViewport;if\(!\3\)return;let ([\w$]+)=document\.documentElement,([\w$]+)=\(\)=>\{[\s\S]*?\};\5\(\),\3\.addEventListener\(`resize`,\5\),window\.addEventListener\(`resize`,\5\),document\.addEventListener\(`focusin`,\5\),document\.addEventListener\(`focusout`,\5\),([\w$]+)\(\(\)=>\{\3\.removeEventListener\(`resize`,\5\),window\.removeEventListener\(`resize`,\5\),document\.removeEventListener\(`focusin`,\5\),document\.removeEventListener\(`focusout`,\5\),\4\.style\.removeProperty\(`--safe-area-inset-bottom`\)\}\)\}\),null\}/,
    (_,fn,mount,_view,_root,_sync,cleanup) => `function ${fn}(){return ${mount}(()=>${cleanup}(window.__FNOS_OPENCODE__.keyboardInsets())),null}`, 'coalesced keyboard viewport updates')
  return Buffer.from(text)
}

export function resource(source, compatibility, requestedPath) {
  const digest = crypto.createHash('sha256').update(source).digest('hex')
  const asset = requestedPath ? compatibility.settings.find(item => item.path === requestedPath) : compatibility.settings.find(item => item.sha256 === digest)
  if (!asset) throw problem('Unsupported upstream settings UI', {stage:'patchSettings',role:'unknown',path:requestedPath ?? 'unknown',actualSha256:digest,actualSize:source.length})
  const context = {stage:'patchSettings',role:asset.role,path:asset.path}
  let text = verified(source, asset, context)
  const edit = (value,build,name) => {text = replaceAnchor(text,value,build,name,context)}
  if (asset.role === 'connection') {
    edit(/var ([\w$]+)=2e3,([\w$]+)=1e3,([\w$]+)=50/,
      (_,timeout,retry,history) => `var ${timeout}=30e3,${retry}=1e3,${history}=50`, 'event stream connection deadline')
    edit(/([\w$]+)\(\{status:`connected`,attempt:0,error:void 0\}\)/,
      match => match + ',window.__FNOS_OPENCODE__.connectionStatus(`connected`)', 'clear connection failure notice')
    edit(/([\w$]+)\(\{status:`reconnecting`,attempt:([\w$]+),error:([\w$]+)\}\)/,
      (match,_setter,attempt,error) => match + `,window.__FNOS_OPENCODE__.connectionStatus(\`reconnecting\`,${error},${attempt})`, 'report connection failure')
  } else if (asset.role === 'router') {
    edit(/([\w$]+)=\(\)=>([\w$]+)\(\)\.location(?=,)/,
      (_,accessor,router) => `${accessor}=()=>window.__FNOS_OPENCODE__.routeLocation(${router}().location)`, 'application route location')
    edit(/([\w$]+)=\(\)=>([\w$]+)\.connection\.status\(\)===`connected`,/,
      (match,ready,sdk) => match + `__fnosReadReady=()=>${ready}()||window.__FNOS_OPENCODE__.readsEnabled(${sdk}),`, 'initial HTTP readiness')
    edit(/(queries:\[\{\.\.\.[\w$]+\([\w$]+\.scope\),enabled:)[\w$]+\(\)/,
      (_,prefix) => prefix + '__fnosReadReady()', 'initial config read')
    edit(/(\.\.\.[\w$]+\([\w$]+\.scope,null,[\w$]+\.api\.location\),enabled:)[\w$]+\(\)/,
      (_,prefix) => prefix + '__fnosReadReady()', 'initial directory read')
    edit(/Date\.now\(\)\),enabled:[\w$]+\(\)(\}\)\)),([\w$]+)=([\w$]+)\(\{owner:/,
      (_,close,variable,constructor) => `Date.now()),enabled:__fnosReadReady()${close},${variable}=${constructor}({owner:`, 'initial project read')
  } else if (asset.role === 'projects') {
    edit(/([\w$]+)\.store\.usedProjectIDs\[\1\.scope\(\)\]\?\?\[\]/,
      (_,state) => `window.__FNOS_OPENCODE__.projectIDs(${state}.scope(),${state}.store.usedProjectIDs[${state}.scope()])`, 'recover historical and upgrade-selected projects')
  } else if (asset.role === 'settings-route') {
    edit(/([\w$]+)=\{general:!0,appearance:!0/,
      (_,routes) => `${routes}={"fnos-updates":!0,general:!0,appearance:!0`, 'program update route')
    edit('projects:!0,workspaces:!0,providers:!0,models:!0,extensions:!0,servers:!0,experimental:!0,about:!0',
      'providers:!0,models:!0,extensions:!0,about:!0', 'limit fnOS settings routes')
  } else if (asset.role === 'settings') {
    // Resolve the About array and its icon from semantic labels, avoiding the
    // similarly shaped project group and stale references to icon object names.
    const about = one(text,/([\w$]+)=\[\{value:`about`,icon:([\w$]+)\.about,label:`settings.tab.about`\}\]/,'about navigation definition',context)
    edit(new RegExp('\\.\\.\\.'+escape(about[1])+'\\.map'),
      match => `{value:\`fnos-updates\`,icon:${about[2]}.about,label:\`程序更新\`},` + match, 'program update navigation')
    edit(/get groups\(\)\{return ([\w$]+)\(\)\}/,
      (_,groups) => `get groups(){return window.__FNOS_OPENCODE__.settingsGroups(${groups}())}`, 'limit fnOS settings navigation')
    edit(/([\w$]+)\(([\w$]+)\.Content,\{value:`about`,class:`settings-panel settings-about`/,
      (match,factory,tabs) => `${factory}(${tabs}.Content,{value:\`fnos-updates\`,class:\`settings-panel\`,get children(){return window.__FNOS_OPENCODE__.updatesPanel()}}),` + match, 'program update panel')
  } else throw problem('Unknown adapter resource role',context)
  return Buffer.from(text)
}
