// Bridge official Console device authorization into OpenCode 1.19's V1 auth hooks.
// No upstream binary patches, credential logging, or third-party auth service.
const SERVER = 'https://opencode.ai/console'
const CLIENT = 'opencode-cli'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function post(path, body) {
  const response = await fetch(SERVER + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json()
  if (!response.ok && !data.error) throw new Error(`Console authorization HTTP ${response.status}`)
  return data
}

function credential(token, previous) {
  if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in)) {
    throw new Error('Console returned an incomplete token')
  }
  return {
    type: 'oauth', access: token.access_token, refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    metadata: { orgID: token.org_id || previous?.metadata?.orgID, server: SERVER },
  }
}

async function remoteOptions(auth, providerID) {
  const headers = { Authorization: `Bearer ${auth.access}` }
  if (auth.metadata?.orgID) headers['x-org-id'] = auth.metadata.orgID
  const response = await fetch(SERVER + '/api/config', { headers, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Console workspace configuration HTTP ${response.status}`)
  const data = await response.json()
  const provider = data.config?.provider?.[providerID]
  if (!provider) throw new Error(`Console workspace does not provide ${providerID}`)
  return {
    ...(provider.options || {}),
    headers: { ...(provider.options?.headers || {}), ...(auth.metadata?.orgID ? { 'x-opencode-org-id': auth.metadata.orgID } : {}) },
    apiKey: auth.access,
  }
}

function makeConsolePlugin(providerID) {
  return async ({ client }) => {
    let refreshing
    async function freshAuth(getAuth) {
      let auth = await getAuth()
      if (auth?.type !== 'oauth') return auth
      if (auth.expires <= Date.now() + 30000) {
        refreshing ||= (async () => {
          const current = await getAuth()
          if (current.expires > Date.now() + 30000) return current
          const result = await post('/auth/device/token', { grant_type: 'refresh_token', refresh_token: current.refresh, client_id: CLIENT })
          if (result.error) throw new Error('Console session refresh failed; reconnect your account')
          const next = credential(result, current)
          await client.auth.set({ path: { id: providerID }, body: next })
          return next
        })().finally(() => { refreshing = undefined })
        auth = await refreshing
      }
      return auth
    }
    return {
      auth: {
        provider: providerID,
        async loader(getAuth, provider) {
          // Provider.list awaits every auth loader. A Console outage must not
          // reject that shared list and hide unrelated providers as well.
          const auth = await getAuth()
          if (auth?.type !== 'oauth') return {}
          let options, configured = false
          try {
            options = await remoteOptions(await freshAuth(getAuth), providerID)
            configured = true
          } catch {
            options = { apiKey: auth.access, headers: auth.metadata?.orgID ? { 'x-opencode-org-id': auth.metadata.orgID } : {} }
          }
          return {
            ...options,
            async fetch(input, init) {
              const url = new URL(input instanceof Request ? input.url : input)
              if (url.origin !== 'https://opencode.ai') throw new Error('Unexpected OpenCode inference origin')
              const current = await freshAuth(getAuth)
              if (current?.type !== 'oauth') throw new Error('Console account disconnected')
              let target = input
              if (!configured) {
                let recovered
                try { recovered = await remoteOptions(current, providerID) }
                catch { throw new Error('OpenCode Console 暂时无法连接，请检查 NAS 网络、系统时间和证书；其他供应商仍可使用。') }
                // Recover after a failed list load without sending a request
                // to a guessed endpoint. Model catalog URLs are the authority.
                if (recovered.baseURL && !url.href.startsWith(recovered.baseURL.replace(/\/$/, '') + '/')) {
                  const bases = Object.values(provider?.models || {}).map(model => model.api?.url).filter(Boolean)
                  const base = bases.find(value => url.href.startsWith(value.replace(/\/$/, '') + '/'))
                  if (!base) throw new Error('Console 已恢复连接，请重新打开项目以加载供应商配置。')
                  target = recovered.baseURL.replace(/\/$/, '') + url.href.slice(base.replace(/\/$/, '').length)
                  if (new URL(target).origin !== 'https://opencode.ai') throw new Error('Unexpected OpenCode inference origin')
                }
                options = recovered
              }
              const headers = new Headers(input instanceof Request ? input.headers : undefined)
              new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
              new Headers(options.headers).forEach((value, key) => headers.set(key, value))
              headers.set('Authorization', `Bearer ${current.access}`)
              if (current.metadata?.orgID) headers.set('x-opencode-org-id', current.metadata.orgID)
              // Keep Request bodies and options when a recovered base URL changes.
              const request = target !== input && input instanceof Request ? new Request(target, input) : target
              return fetch(request, { ...init, headers })
            },
          }
        },
        methods: [
          {
            type: 'oauth',
            label: 'OpenCode Console account (Go subscription)',
            async authorize() {
              const device = await post('/auth/device/code', { client_id: CLIENT, supports_org_scope: 'true' })
              if (device.error || !device.device_code || !device.user_code || !device.verification_uri_complete) {
                throw new Error('Console device authorization could not be started')
              }
              const url = new URL(device.verification_uri_complete, SERVER + '/')
              if (url.origin !== 'https://opencode.ai') throw new Error('Unexpected Console authorization origin')
              let interval = Math.max(5, Number(device.interval) || 5) * 1000
              const deadline = Date.now() + Math.min(600, Number(device.expires_in) || 600) * 1000
              return {
                url: url.href, method: 'auto', instructions: `Open the link and authorize your Go workspace. Code: ${device.user_code}`,
                async callback() {
                  while (Date.now() < deadline) {
                    await wait(interval)
                    const result = await post('/auth/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: CLIENT })
                    if (result.error === 'authorization_pending') continue
                    if (result.error === 'slow_down') { interval += 5000; continue }
                    if (result.error) return { type: 'failed' }
                    const auth = credential(result)
                    // Check the selected workspace before marking the account connected.
                    await remoteOptions(auth, providerID)
                    return { ...auth, type: 'success' }
                  }
                  return { type: 'failed' }
                },
              }
            },
          },
          { type: 'api', label: 'Manually enter API Key' },
        ],
      },
    }
  }
}

export const OpenCodeConsole = makeConsolePlugin('opencode')
export const OpenCodeGoConsole = makeConsolePlugin('opencode-go')
