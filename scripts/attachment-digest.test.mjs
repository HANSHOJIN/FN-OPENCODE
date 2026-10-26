import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { attachmentDigest, sha256 } from '../opencode-fnos/app/gateway/attachment-digest.mjs'

const hex = buffer => Buffer.from(buffer).toString('hex')
test('HTTP attachment hashing matches SHA256 for empty, boundary, Unicode and binary contents', async () => {
  const examples = ['', 'abc', '# 项目移交\n这是一个中文 Markdown 附件。\n']
    .map(text => Buffer.from(text))
  for (const size of [55,56,63,64,65,119,120,127,128,11264,1000000]) examples.push(randomBytes(size))
  for (const content of examples) {
    const expected = createHash('sha256').update(content).digest('hex')
    assert.equal(hex(sha256(Uint8Array.from(content).buffer)), expected)
    assert.equal(hex(await attachmentDigest(new Blob([content]), {})), expected)
  }
})
test('11KB Markdown attachment has the same content ID on HTTP and HTTPS', async () => {
  const file = new File(['# 项目移交\n' + '测试内容\n'.repeat(800)], '项目移交.MD', {type:'text/markdown'})
  const http = await attachmentDigest(file, {})
  const https = await attachmentDigest(file, webcrypto)
  assert.equal(hex(http), hex(https))
  const other = await attachmentDigest(new File(['different'], '项目移交.MD'), {})
  assert.notEqual(hex(http), hex(other))
})
