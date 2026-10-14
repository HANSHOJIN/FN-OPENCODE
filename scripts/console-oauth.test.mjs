import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeGoConsole } from '../opencode-fnos/app/plugins/console-oauth.mjs'

test('device login validates workspace and uses the V1 callback credential format', async () => {
  const oldFetch = globalThis.fetch, oldTimer = globalThis.setTimeout
  const calls = []
  globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0 }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    const data = url.endsWith('/code')
      ? { device_code: 'device', user_code: 'ABCD', verification_uri_complete: '/console/device?user_code=ABCD', expires_in: 600, interval: 5 }
      : url.endsWith('/token')
        ? { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, org_id: 'test-org' }
        : { config: { provider: { 'opencode-go': { options: { baseURL: 'https://opencode.ai/test-go' } } } } }
    return { ok: true, json: async () => data }
  }
  try {
    const plugin = await OpenCodeGoConsole({ client: {} })
    const flow = await plugin.auth.methods[0].authorize()
    assert.equal(flow.method, 'auto')
    assert.equal(new URL(flow.url).origin, 'https://opencode.ai')
    const result = await flow.callback()
    assert.equal(result.type, 'success')
    assert.equal(result.metadata.orgID, 'test-org')
    assert.equal(result.refresh, 'test-refresh')
    assert.equal(new URLSearchParams(calls[0].options.body).get('supports_org_scope'), 'true')
    assert.equal(calls.at(-1).options.headers['x-org-id'], 'test-org')
  } finally { globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimer }
})

test('concurrent loaders redeem a rotating refresh token only once', async () => {
  const oldFetch = globalThis.fetch
  let auth = { type: 'oauth', access: 'expired', refresh: 'refresh-once', expires: 0, metadata: { orgID: 'org' } }
  let refreshes = 0, writes = 0
  globalThis.fetch = async (url) => {
    if (url.endsWith('/token')) {
      refreshes++
      return { ok: true, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }) }
    }
    return { ok: true, json: async () => ({ config: { provider: { 'opencode-go': { options: { baseURL: 'https://opencode.ai/test' } } } } }) }
  }
  try {
    const plugin = await OpenCodeGoConsole({ client: { auth: { set: async ({ body }) => { auth = body; writes++ } } } })
    const options = await Promise.all([plugin.auth.loader(async () => auth), plugin.auth.loader(async () => auth)])
    assert.equal(refreshes, 1)
    assert.equal(writes, 1)
    assert.equal(options[0].apiKey, 'new-access')
    assert.equal(options[1].headers['x-opencode-org-id'], 'org')
  } finally { globalThis.fetch = oldFetch }
})

test('unexpected authorization origin is rejected', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ device_code: 'device', user_code: 'code', verification_uri_complete: 'https://example.invalid/steal' }) })
  try {
    const plugin = await OpenCodeGoConsole({ client: {} })
    await assert.rejects(plugin.auth.methods[0].authorize(), /Unexpected Console authorization origin/)
  } finally { globalThis.fetch = oldFetch }
})

test('a Console certificate failure does not reject the shared provider loader and can recover', async () => {
 const oldFetch=globalThis.fetch
 const auth={type:'oauth',access:'test-access',refresh:'test-refresh',expires:Date.now()+3600000,metadata:{orgID:'test-org'}}
 let offline=true, sent
 globalThis.fetch=async (input,init)=>{
  if(String(input).endsWith('/api/config')) {
   if(offline) throw new Error('unknown certificate verification error')
   return {ok:true,json:async()=>({config:{provider:{'opencode-go':{options:{baseURL:'https://opencode.ai/recovered/v1'}}}}})}
  }
  sent={input,init};return {ok:true}
 }
 try {
  const plugin=await OpenCodeGoConsole({client:{}})
  const options=await plugin.auth.loader(async()=>auth,{models:{test:{api:{url:'https://opencode.ai/zen/go/v1'}}}})
  assert.equal(options.apiKey,'test-access')
  await assert.rejects(options.fetch('https://opencode.ai/zen/go/v1/chat/completions',{method:'POST',body:'{"test":true}'}),/其他供应商仍可使用/)
  offline=false
  await options.fetch('https://opencode.ai/zen/go/v1/chat/completions',{method:'POST',body:'{"test":true}'})
  assert.equal(sent.input,'https://opencode.ai/recovered/v1/chat/completions')
  assert.equal(sent.init.body,'{"test":true}')
  assert.equal(sent.init.headers.get('Authorization'),'Bearer test-access')
 } finally {globalThis.fetch=oldFetch}
})

test('an expired Console credential with failed refresh does not hide other providers', async()=>{
 const oldFetch=globalThis.fetch
 globalThis.fetch=async()=>{throw new Error('certificate verification failed')}
 try {
  const plugin=await OpenCodeGoConsole({client:{}})
  const options=await plugin.auth.loader(async()=>({type:'oauth',access:'expired',refresh:'test-refresh',expires:0}))
  assert.equal(typeof options.fetch,'function')
  assert.equal(options.apiKey,'expired')
 } finally {globalThis.fetch=oldFetch}
})
