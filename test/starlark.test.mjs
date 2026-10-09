import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const asset = readFileSync('dist/comment-json.bundle.mjs', 'utf8')
const sha256 = createHash('sha256').update(asset).digest('hex')
const snippet = `{
  "log": { "level": "info" },
  "inbounds": [
    { "type": "mixed", "tag": "mixed-in", },
    /* @starlark
    if host.client == "cli":
      result = omit
    else:
      result = value
    */
    { "type": "tun", "auto_redirect": /* @starlark
      if host.os == "windows":
        result = omit
      else:
        result = value
      */ true, "platform": { "http_proxy": { "enabled": true } }, },
  ],
  "dns": { "servers": [] },
  "outbounds": [ { "type": "selector", "tag": "🗺️ all", "outbounds": [] } ],
}`
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function run(file, { content = '', files = [], args = {}, artifact, cache = new Map(), substore } = {}) {
  const code = readFileSync(file, 'utf8')
  const resourceCache = {
    get: (key) => cache.get(key),
    set: (key, value) => cache.set(key, value),
  }
  const execute = new AsyncFunction('$content', '$files', '$arguments', 'produceArtifact', 'scriptResourceCache', '$substore', 'yaml', 'require', 'console', `${code}\nreturn $content`)
  return execute(content, files, args, async (options) => {
    if (options.type === 'file' && options.name === 'comment-json') return artifact
    if (options.platform === 'sing-box') return [{ type: 'direct', tag: 'from-sub' }]
    throw new Error(`Unexpected produceArtifact: ${JSON.stringify(options)}`)
  }, resourceCache, substore, {}, requireFn, console)
}

function requireFn(name) {
  if (name === 'node:crypto') return requireCrypto
  throw new Error(`Unexpected require: ${name}`)
}
const requireCrypto = await import('node:crypto')

test('template preserves arbitrary nested Starlark markers while adding outbounds', async () => {
  const output = await run('sing-box/template.js', {
    files: [snippet],
    args: { name: 'my-sub', type: 'subscription' },
    artifact: asset,
  })
  assert.equal((output.match(/@starlark/g) || []).length, 2)
  assert.match(output, /host\.client == "cli"/)
  assert.match(output, /"auto_redirect":\s*\/\* @starlark/)
  const { library } = await import(`data:text/javascript;base64,${Buffer.from(asset).toString('base64')}`)
  const config = library.parse(output)
  assert.ok(config.outbounds.some((item) => item.tag === 'from-sub'))
  assert.equal(config.inbounds[1].platform.http_proxy.enabled, true)
})

test('xhttp injection preserves comments when changing an outbound', async () => {
  const encryption = `mlkem768x25519plus.native.1rtt.${Buffer.alloc(32, 7).toString('base64url')}`
  const key = 'xhttp-node:v2:' + JSON.stringify(['from-sub', 'vless', 'example.org', null, ''])
  const cache = new Map([[key, {
    network: 'xhttp', xhttpOpts: { path: '/x' }, encryption,
  }]])
  const output = await run('sing-box/xhttp-inject.js', {
    content: snippet.replace('"type": "selector", "tag": "🗺️ all", "outbounds": []', '"type": "vless", "tag": "from-sub", "server": "example.org"'),
    cache, artifact: asset,
  })
  assert.equal((output.match(/@starlark/g) || []).length, 2)
  assert.match(output, /"transport":\s*\{\s*"type": "xhttp"/)
  assert.ok(output.includes(encryption))
})

test('psn injection edits DNS and outbound without erasing Starlark', async () => {
  const input = snippet.replace('"type": "selector", "tag": "🗺️ all", "outbounds": []',
    '"type": "vless", "tag": "provider / test", "server": "example.org"')
  const output = await run('psn-inject.js', {
    content: input, artifact: asset,
    args: { psnSub: 'provider', psn: 'https://dns.example/dns-query' },
  })
  assert.equal((output.match(/@starlark/g) || []).length, 2)
  const { library } = await import(`data:text/javascript;base64,${Buffer.from(asset).toString('base64')}`)
  const result = library.parse(output)
  assert.equal(result.dns.servers.at(-1).server, 'dns.example')
  assert.equal(result.outbounds[0].domain_resolver, 'psn')
})

test('optional fork render verifies script attachment after comment-json serialization', async (t) => {
  if (!process.env.SING_BOX_BIN) return t.skip('set SING_BOX_BIN to the Starlark-enabled sing-box binary')
  const { library } = await import(`data:text/javascript;base64,${Buffer.from(asset).toString('base64')}`)
  const input = `{"log":{"level": /* @starlark\nresult = "debug"\n*/ "info"},"inbounds":[/* @starlark\nresult = omit\n*/{"type":"mixed","tag":"local","listen":"127.0.0.1","listen_port":2080}],"outbounds":[{"type":"direct","tag":"direct"}],"route":{"final":"direct"}}`
  const config = library.parse(input)
  config.outbounds.push({ type: 'direct', tag: 'extra' })
  const directory = mkdtempSync(join(tmpdir(), 'substore-starlark-'))
  try {
    const file = join(directory, 'config.json')
    writeFileSync(file, library.stringify(config, null, 2))
    const result = spawnSync(process.env.SING_BOX_BIN, ['render', '-c', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const rendered = JSON.parse(result.stdout)
    assert.equal(rendered.log.level, 'debug')
    assert.equal(rendered.inbounds, undefined)
    assert.equal(rendered.outbounds[1].tag, 'extra')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('checksum is optional, but rejects mismatches or malformed digests when supplied', async () => {
  const verified = await run('psn-inject.js', {
    content: snippet, artifact: asset, args: { commentJsonSha256: sha256.toUpperCase() },
  })
  assert.match(verified, /@starlark/)
  await assert.rejects(run('psn-inject.js', {
    content: snippet, artifact: 'untrusted code', args: { commentJsonSha256: sha256 },
  }), /checksum mismatch/)
  await assert.rejects(run('psn-inject.js', {
    content: snippet, artifact: asset, args: { commentJsonSha256: 'bad' },
  }), /Invalid commentJsonSha256/)
})
