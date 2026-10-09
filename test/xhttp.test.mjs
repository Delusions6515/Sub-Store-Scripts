import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const prep = new Function('scriptResourceCache', `${readFileSync('sing-box/xhttp-prep.js', 'utf8')}\nreturn operator`)
const inject = new AsyncFunction('$content', '$arguments', 'produceArtifact', 'scriptResourceCache',
  `${readFileSync('sing-box/xhttp-inject.js', 'utf8')}\nreturn $content`)
const asset = readFileSync('dist/comment-json.bundle.mjs', 'utf8')
const { library } = await import(`data:text/javascript;base64,${Buffer.from(asset).toString('base64')}`)
const encryption = `mlkem768x25519plus.native.0rtt.${Buffer.alloc(32, 7).toString('base64url')}`
const node = (overrides = {}) => ({
  name: 'test', type: 'vless', server: 'example.org', port: 443,
  uuid: 'bf000d23-0752-40b4-affe-68f7707a9661', ...overrides,
})
function cache() {
  const entries = new Map()
  return { entries, get: (key) => entries.get(key), set: (key, value, ttl) => {
    assert.equal(ttl, 12 * 60 * 60 * 1000)
    entries.set(key, value)
  } }
}
function produced(proxy) {
  assert.notEqual(proxy.network, 'xhttp')
  assert.notEqual(proxy.network, 'splithttp')
  assert.ok(!proxy.encryption || proxy.encryption === 'none')
  const outbound = { type: proxy.type, tag: proxy.name, server: proxy.server,
    server_port: Number(proxy.port), uuid: proxy.uuid }
  if (proxy.flow) outbound.flow = proxy.flow
  return outbound
}
async function restore(outbounds, resourceCache) {
  const output = await inject(JSON.stringify({ outbounds }), {}, async () => asset, resourceCache)
  return JSON.parse(JSON.stringify(library.parse(output))).outbounds
}
async function roundtrip(proxy) {
  const resourceCache = cache()
  prep(resourceCache)([proxy], 'sing-box')
  return (await restore([produced(proxy)], resourceCache))[0]
}

test('prep saves XHTTP and Encryption together and leaves other platforms untouched', async () => {
  const proxy = node({ network: 'xhttp', 'xhttp-opts': { path: '/x?foo=bar' }, encryption, flow: 'xtls-rprx-vision' })
  const original = structuredClone(proxy)
  const resourceCache = cache()
  assert.equal(prep(resourceCache)([proxy], 'mihomo')[0], proxy)
  assert.deepEqual(proxy, original)
  assert.equal(resourceCache.entries.size, 0)
  prep(resourceCache)([proxy], 'SingBox')
  assert.equal(resourceCache.entries.size, 1)
  assert.equal(proxy.network, 'tcp')
  assert.equal(proxy['xhttp-opts'], undefined)
  assert.equal(proxy.encryption, undefined)
  const [outbound] = await restore([produced(proxy)], resourceCache)
  assert.equal(outbound.encryption, encryption)
  assert.equal(outbound.flow, 'xtls-rprx-vision')
  assert.deepEqual(outbound.transport, { type: 'xhttp', path: '/x?foo=bar' })
})

test('encryption-only, VMess and splithttp nodes round-trip without adding defaults', async () => {
  const encrypted = await roundtrip(node({ encryption, network: 'ws' }))
  assert.equal(encrypted.encryption, encryption)
  assert.equal(encrypted.transport, undefined)
  const vmess = await roundtrip(node({ type: 'vmess', network: 'splithttp', 'splithttp-opts': { mode: 'stream-up' } }))
  assert.deepEqual(vmess.transport, { type: 'xhttp', mode: 'stream-up' })
  assert.equal(vmess.encryption, undefined)
})

test('same-name nodes are keyed by connection identity and normal nodes clear old snapshots', async () => {
  const resourceCache = cache()
  const a = node({ network: 'xhttp', 'xhttp-opts': { path: '/a' }, encryption })
  const b = node({ server: 'other.org', network: 'xhttp', 'xhttp-opts': { path: '/b' } })
  prep(resourceCache)([a, b], 'sing-box')
  const [first, second, direct] = await restore([produced(a), produced(b), { type: 'direct', tag: a.name }], resourceCache)
  assert.equal(first.transport.path, '/a')
  assert.equal(first.encryption, encryption)
  assert.equal(second.transport.path, '/b')
  assert.equal(second.encryption, undefined)
  assert.equal(direct.transport, undefined)
  const plain = node({ encryption: 'none' })
  prep(resourceCache)([plain], 'sing-box')
  assert.equal((await restore([produced(plain)], resourceCache))[0].transport, undefined)
})

test('latest XHTTP fields, legacy session aliases, Host and XMUX map to the new schema', async () => {
  const opts = {
    host: ['a.example', 'b.example'], path: '/upload?token=1', mode: 'auto',
    headers: { hOsT: 'ignored.example', 'X-Test': ['one', 'two'] },
    'x-padding-bytes': '100-1000', 'x-padding-obfs-mode': false,
    'x-padding-key': 'pad', 'x-padding-header': 'X-Pad', 'x-padding-placement': 'header', 'x-padding-method': 'repeat-x',
    'uplink-http-method': 'POST', 'session-placement': 'path', 'session-key': 'sid',
    'session-table': 'abc', 'session-length': '8-16', 'seq-placement': 'query', 'seq-key': 'seq',
    'uplink-data-placement': 'body', 'uplink-data-key': 'data', 'uplink-chunk-size': 0,
    'no-grpc-header': false, 'no-sse-header': true,
    'sc-max-each-post-bytes': 1000000, 'sc-min-posts-interval-ms': '10-20', 'sc-max-buffered-posts': 30,
    'sc-stream-up-server-secs': '20-80', 'server-max-header-bytes': 8192,
    'sc-max-concurrent-posts': 99, 'user-agent': 'firefox', 'quic-congestion': 'bbr', 'quic-up': 65536,
    'reuse-settings': { 'max-connections': '3', 'h-max-request-times': [600, 900],
      'h-max-reusable-secs': { from: 1800, to: 3000 }, 'h-keep-alive-period': -1 },
  }
  const outbound = await roundtrip(node({ network: 'xhttp', 'xhttp-opts': opts }))
  assert.deepEqual(outbound.transport, {
    type: 'xhttp', host: ['a.example', 'b.example'], path: '/upload?token=1', mode: 'auto',
    headers: { 'X-Test': ['one', 'two'] },
    x_padding_bytes: '100-1000', x_padding_obfs_mode: false,
    x_padding_key: 'pad', x_padding_header: 'X-Pad', x_padding_placement: 'header', x_padding_method: 'repeat-x',
    uplink_http_method: 'POST', session_placement: 'path', session_key: 'sid', session_id_table: 'abc', session_id_length: '8-16',
    seq_placement: 'query', seq_key: 'seq', uplink_data_placement: 'body', uplink_data_key: 'data', uplink_chunk_size: 0,
    no_grpc_header: false, no_sse_header: true, sc_max_each_post_bytes: 1000000,
    sc_min_posts_interval_ms: '10-20', sc_max_buffered_posts: 30, sc_stream_up_server_secs: '20-80', server_max_header_bytes: 8192,
    user_agent: 'firefox', quic_congestion: 'bbr', quic_up: 65536,
    xmux: { max_connections: '3', h_max_request_times: '600-900', h_max_reusable_secs: '1800-3000', h_keep_alive_period: -1 },
  })
  const fallback = await roundtrip(node({ network: 'xhttp', 'xhttp-opts': { headers: { HOST: ' a.example, b.example ' } } }))
  assert.deepEqual(fallback.transport, { type: 'xhttp', host: ['a.example', 'b.example'] })
  assert.deepEqual(opts.headers.hOsT, 'ignored.example')
})

test('Sub-Store unsupported URI extra fields are restored with structured edits taking precedence', async () => {
  const outbound = await roundtrip(node({ network: 'xhttp',
    'xhttp-opts': { path: '/edited', 'x-padding-bytes': '200-300', 'session-id-length': 12 },
    _extra_unsupported: { path: '/ignored', noSSEHeader: false, scMaxBufferedPosts: 30,
      scStreamUpServerSecs: '20-80', sessionIDTable: 'abc', xPaddingBytes: '100-200', xmux: { maxConnections: 5 } },
  }))
  assert.equal(outbound.transport.path, '/edited')
  assert.equal(outbound.transport.x_padding_bytes, '200-300')
  assert.equal(outbound.transport.session_id_length, 12)
  assert.equal(outbound.transport.session_id_table, 'abc')
  assert.equal(outbound.transport.no_sse_header, false)
  assert.equal(outbound.transport.sc_max_buffered_posts, 30)
  assert.equal(outbound.transport.sc_stream_up_server_secs, '20-80')
  assert.deepEqual(outbound.transport.xmux, { max_connections: 5 })
})

test('native download settings keep TLS/dial fields and never inherit upload XHTTP settings', async () => {
  const download = { server: 'download.example', server_port: 443, path: '/down',
    tls: { enabled: true, server_name: 'sni.example', alpn: ['h3'], ech: { enabled: true, config: ['test'] } },
    bind_interface: 'eth0', detour: 'direct', xmux: {}, headers: { Host: 'host.example' } }
  const outbound = await roundtrip(node({ network: 'xhttp', 'xhttp-opts': {
    path: '/up', host: 'upload.example', 'x-padding-bytes': 500, 'reuse-settings': { 'max-connections': 5 },
    download_settings: download,
  } }))
  assert.deepEqual(outbound.transport.download_settings, {
    server: 'download.example', server_port: 443, path: '/down', host: 'host.example',
    tls: download.tls, bind_interface: 'eth0', detour: 'direct', xmux: {},
  })
  assert.equal(outbound.transport.download_settings.type, undefined)
  assert.equal(outbound.transport.download_settings.x_padding_bytes, undefined)
  const empty = await roundtrip(node({ network: 'xhttp', 'xhttp-opts': { 'download-settings': {} } }))
  assert.deepEqual(empty.transport.download_settings, {})
})

test('Sub-Store download TLS/REALITY and residual Xray download fields are converted independently', async () => {
  const outbound = await roundtrip(node({ network: 'xhttp', 'xhttp-opts': { 'download-settings': {
    server: 'cdn.example', port: 443, tls: true, servername: 'sni.example', alpn: ['h2'],
    'client-fingerprint': 'firefox', 'skip-cert-verify': false, path: '/down',
    'reality-opts': { 'public-key': 'key', 'short-id': 'abcd' },
  } }, _extra_unsupported: { downloadSettings: {
    xhttpSettings: { noSSEHeader: true, scMaxBufferedPosts: 20 },
  } } }))
  assert.deepEqual(outbound.transport.download_settings, {
    server: 'cdn.example', server_port: 443, path: '/down', no_sse_header: true, sc_max_buffered_posts: 20,
    tls: { enabled: true, server_name: 'sni.example', alpn: ['h2'], insecure: false,
      utls: { enabled: true, fingerprint: 'firefox' }, reality: { enabled: true, public_key: 'key', short_id: 'abcd' } },
  })
})

test('raw URI extra and REALITY password fallback survive Sub-Store partial normalization', async () => {
  const password = Buffer.alloc(32, 8).toString('base64url')
  const outbound = await roundtrip(node({ network: 'xhttp',
    'xhttp-opts': { 'download-settings': { tls: true, 'reality-opts': {} } },
    _extra_unsupported: { downloadSettings: { realitySettings: { password, shortId: 'abcd' } } },
  }))
  assert.equal(outbound.transport.download_settings.tls.reality.public_key, password)
  assert.equal(outbound.transport.download_settings.tls.reality.short_id, 'abcd')
  const raw = await roundtrip(node({ network: 'xhttp', _extra: JSON.stringify({
    noGRPCHeader: false, downloadSettings: { address: 'cdn.example', port: 443, security: 'tls',
      tlsSettings: { serverName: 'cdn.example', alpn: ['h3'], allowInsecure: false },
      xhttpSettings: { path: '/down', xmux: { maxConnections: 3 } },
    },
  }) }))
  assert.deepEqual(raw.transport.download_settings, {
    server: 'cdn.example', server_port: 443, path: '/down', xmux: { max_connections: 3 },
    tls: { enabled: true, server_name: 'cdn.example', alpn: ['h3'], insecure: false },
  })
})

test('malformed ranges/options fail instead of silently replacing them with defaults', async () => {
  await assert.rejects(roundtrip(node({ network: 'xhttp', 'xhttp-opts': { 'session-length': { nope: 1 } } })), /range/i)
  await assert.rejects(roundtrip(node({ network: 'xhttp', 'xhttp-opts': 'invalid' })), /object/i)
})

test('optional latest fork check accepts encrypted Vision over XHTTP with separate TLS download', async (t) => {
  if (!process.env.SING_BOX_XHTTP_BIN) return t.skip('set SING_BOX_XHTTP_BIN to the latest with_xhttp build')
  const outbound = await roundtrip(node({ network: 'xhttp', encryption, flow: 'xtls-rprx-vision',
    'xhttp-opts': { path: '/up', 'session-table': '0123456789abcdef', 'session-length': 16,
      'reuse-settings': { 'max-connections': 3 }, 'download-settings': {
        server: 'download.example', port: 443, tls: true, servername: 'download.example', alpn: ['h2'], path: '/down',
      } },
  }))
  const directory = mkdtempSync(join(tmpdir(), 'substore-xhttp-'))
  try {
    const file = join(directory, 'config.json')
    writeFileSync(file, JSON.stringify({ outbounds: [outbound] }))
    const result = spawnSync(process.env.SING_BOX_XHTTP_BIN, ['check', '-c', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
