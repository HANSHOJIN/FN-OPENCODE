import test from 'node:test'
import assert from 'node:assert/strict'
import {standaloneURL} from '../opencode-fnos/app/gateway/window-theme.mjs'

test('standalone links use the current host and configured HTTP service port', () => {
  assert.equal(standaloneURL('http://nas.example:5666/app/opencode-fnos/session', 4096), 'http://nas.example:4096/')
  assert.equal(standaloneURL('https://nas.example:5667/app/opencode-fnos/?private=value#session', 8123), 'http://nas.example:8123/')
  assert.equal(standaloneURL('http://[fd00::1]:5666/app/opencode-fnos/', 4097), 'http://[fd00::1]:4097/')
  assert.equal(standaloneURL('http://name:password@nas.example:5666/app/opencode-fnos/', 4096), 'http://nas.example:4096/')
})

test('invalid direct-link ports and unsupported origins never produce a link', () => {
  for (const port of [undefined, 0, 80, -1, 65536, 4096.5, '4096/other']) assert.equal(standaloneURL('https://nas.example:5667/', port), null)
  for (const origin of ['file:///tmp/example', 'javascript:alert(1)', 'invalid']) assert.equal(standaloneURL(origin, 4096), null)
})
