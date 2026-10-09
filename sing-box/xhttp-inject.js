// Sub-Store 文件响应脚本，放在 template.js 之后，与 xhttp-prep.js 同步升级。
// 映射到当前 sing-box 的 XHTTP transport 与 VLESS encryption 字段。
// 只输出新版字段；支持 Sub-Store kebab-case、原生 snake_case 和残留 Xray extra。
// download_settings 的 XHTTP/TLS 参数独立，不继承上行；Encryption 原样恢复。
// comment-json 保留 JSONC/Starlark 注释；探路时的 $content ReferenceError 原样抛出。

// comment-json is supplied by a Sub-Store file (local or Release URL).
async function loadCommentJSON() {
  const file = $arguments?.commentJsonFile || 'comment-json'
  const code = await produceArtifact({ type: 'file', name: file })
  const expected = $arguments?.commentJsonSha256
  if (expected != null && expected !== '') {
    if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Invalid commentJsonSha256')
    if (typeof require !== 'function') throw new Error('commentJsonSha256 requires Node.js crypto')
    const digest = require('node:crypto').createHash('sha256').update(code).digest('hex')
    if (digest !== expected.toLowerCase()) throw new Error(`Sub-Store file ${file} checksum mismatch`)
  }
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  const library = (await import(moduleUrl)).library
  if (typeof library?.parse !== 'function' || typeof library?.stringify !== 'function') {
    throw new Error('Sub-Store file does not export comment-json')
  }
  return library
}

const XHTTP_CACHE_PREFIX = 'xhttp-node:v2:' // 与 xhttp-prep.js 一致
const XHTTP_FIELDS = [
  'path', 'mode', 'x_padding_bytes', 'x_padding_obfs_mode', 'x_padding_key',
  'x_padding_header', 'x_padding_placement', 'x_padding_method', 'uplink_http_method',
  'session_placement', 'session_key', 'session_id_table', 'session_id_length',
  'seq_placement', 'seq_key', 'uplink_data_placement', 'uplink_data_key', 'uplink_chunk_size',
  'no_grpc_header', 'no_sse_header', 'sc_max_each_post_bytes', 'sc_min_posts_interval_ms',
  'sc_max_buffered_posts', 'sc_stream_up_server_secs', 'server_max_header_bytes',
  'user_agent', 'quic_congestion', 'quic_up',
]
const XMUX_FIELDS = [
  'max_concurrency', 'max_connections', 'c_max_reuse_times', 'h_max_request_times',
  'h_max_reusable_secs', 'h_keep_alive_period',
]
const RANGE_FIELDS = new Set([
  'x_padding_bytes', 'session_id_length', 'uplink_chunk_size', 'sc_max_each_post_bytes',
  'sc_min_posts_interval_ms', 'sc_stream_up_server_secs', ...XMUX_FIELDS.slice(0, 5),
])
const ALIASES = {
  uplink_http_method: ['uplinkHTTPMethod'],
  session_placement: ['sessionIDPlacement'],
  session_key: ['sessionIDKey'],
  session_id_table: ['session-table', 'session_table', 'sessionIDTable'],
  session_id_length: ['session-length', 'session_length', 'sessionIDLength'],
  no_grpc_header: ['noGRPCHeader'],
  no_sse_header: ['noSSEHeader'],
  xmux: ['reuse-settings'],
  server: ['address'],
  server_port: ['port'],
}
const DIAL_FIELDS = [
  'detour', 'bind_interface', 'inet4_bind_address', 'inet6_bind_address', 'bind_address_no_port',
  'routing_mark', 'reuse_addr', 'netns', 'connect_timeout', 'tcp_fast_open', 'tcp_multi_path',
  'disable_tcp_keep_alive', 'tcp_keep_alive', 'tcp_keep_alive_interval', 'tcp_keep_alive_count',
  'udp_fragment', 'domain_resolver', 'network_strategy', 'network_type', 'fallback_network_type',
  'fallback_delay', 'domain_strategy',
]

function isPlainObject(value) {
  return value != null && Object.prototype.toString.call(value) === '[object Object]'
}

function object(value, label) {
  if (value == null) return {}
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function field(sources, key, aliases = ALIASES[key] || []) {
  const keys = [key, key.replaceAll('_', '-'), key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases]
  for (const source of sources) {
    for (const name of keys) {
      if (source?.[name] != null) return source[name]
    }
  }
}

function range(value) {
  if (Array.isArray(value) && value.length === 2) value = `${value[0]}-${value[1]}`
  else if (isPlainObject(value) && value.from != null && value.to != null) value = `${value.from}-${value.to}`
  const match = typeof value === 'string' && value.trim().match(/^([+-]?\d+)(?:\s*-\s*([+-]?\d+))?$/)
  let numbers = []
  if (typeof value === 'number') numbers = [value]
  else if (match) numbers = [Number(match[1]), Number(match[2] ?? match[1])]
  if (!numbers.length || numbers.some(n => !Number.isInteger(n) || n < -2147483648 || n > 2147483647)) {
    throw new Error('Invalid XHTTP range: expected an int32 or a range string')
  }
  return value
}

function copyFields(target, sources, keys) {
  for (const key of keys) {
    const value = field(sources, key)
    if (value != null && value !== '') target[key] = RANGE_FIELDS.has(key) ? range(value) : value
  }
}

function buildXhttpOptions(sources) {
  const options = {}
  copyFields(options, sources, XHTTP_FIELDS)
  const headers = Object.assign({}, ...sources.slice().reverse().map(s => object(s.headers, 'headers')))
  let host = field(sources, 'host')
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'host') continue
    host ??= headers[key]
    delete headers[key]
  }
  if (host != null && host !== '') {
    if (typeof host === 'string' && host.includes(',')) host = host.split(',').map(s => s.trim()).filter(Boolean)
    if (typeof host !== 'string' && !(Array.isArray(host) && host.every(h => typeof h === 'string'))) {
      throw new Error('XHTTP host must be a string or an array of strings')
    }
    options.host = host
  }
  if (Object.keys(headers).length) options.headers = headers
  const xmuxSources = sources.map(s => field([s], 'xmux')).filter(v => v != null)
  if (xmuxSources.length) {
    options.xmux = {}
    copyFields(options.xmux, xmuxSources.map(v => object(v, 'xmux')), XMUX_FIELDS)
  }
  return options
}

function buildDownloadTLS(download, raw) {
  if (isPlainObject(download.tls)) return download.tls // 原生 TLS（包括证书、ECH）直接保留
  const security = raw.security
  if (security && !['none', 'tls', 'reality'].includes(security)) {
    throw new Error(`Unsupported download security: ${security}`)
  }
  const reality = download['reality-opts'] ?? raw.realitySettings
  const enabled = download.tls ?? (security === 'tls' || security === 'reality' || reality != null)
  if (!enabled && download.tls == null && security == null) return
  if (typeof enabled !== 'boolean') throw new Error('download TLS must be a boolean or an object')
  const tls = { enabled }
  const tlsSources = [download, object(raw.tlsSettings, 'tlsSettings')]
  const sni = field(tlsSources, 'server_name', ['servername', 'sni', 'serverName']) ?? raw.realitySettings?.serverName
  if (sni != null) tls.server_name = sni
  const insecure = field(tlsSources, 'insecure', ['skip-cert-verify', 'allowInsecure'])
  if (insecure != null) tls.insecure = insecure
  const alpn = field(tlsSources, 'alpn') ?? raw.alpn
  if (alpn != null) tls.alpn = typeof alpn === 'string' ? [alpn] : alpn
  const fingerprint = download['client-fingerprint'] ?? raw.realitySettings?.fingerprint ?? raw.tlsSettings?.fingerprint
  if (fingerprint || reality || security === 'reality') tls.utls = { enabled: true, fingerprint: fingerprint || 'chrome' }
  if (reality || security === 'reality') {
    const sources = [object(download['reality-opts'], 'reality-opts'), object(raw.realitySettings, 'realitySettings')]
    tls.reality = { enabled: true }
    const key = field(sources, 'public_key', ['public-key', 'publicKey', 'password'])
    if (key) tls.reality.public_key = key
    const shortId = field(sources, 'short_id', ['short-id', 'shortId'])
    if (shortId != null) tls.reality.short_id = shortId
  }
  const ech = download['ech-opts']
  if (ech != null) {
    object(ech, 'ech-opts')
    tls.ech = {}
    const fields = { enable: 'enabled', config: 'config', 'config-path': 'config_path', 'query-server-name': 'query_server_name' }
    for (const [source, target] of Object.entries(fields)) {
      if (ech[source] != null) tls.ech[target] = ech[source]
    }
    if (typeof tls.ech.config === 'string') tls.ech.config = [tls.ech.config]
  }
  return tls
}

function buildDownload(download, raw) {
  download = object(download, 'download_settings')
  raw = object(raw, 'downloadSettings')
  const network = download.network ?? raw.network
  if (network && !['xhttp', 'splithttp'].includes(network)) throw new Error(`Unsupported download network: ${network}`)
  const nested = object(raw.xhttpSettings ?? raw.splithttpSettings, 'download xhttpSettings')
  const options = buildXhttpOptions([download, nested, object(nested.extra, 'download extra')])
  copyFields(options, [download, raw], ['server', 'server_port', ...DIAL_FIELDS])
  const tls = buildDownloadTLS(download, raw)
  if (tls) options.tls = tls
  if (download.fingerprint || download['tls-fingerprint']) {
    throw new Error('download certificate fingerprint cannot be converted; use native tls certificate pinning')
  }
  return options
}

function buildXhttpTransport(snapshot) {
  const opts = object(snapshot.xhttpOpts, 'xhttp-opts')
  let extra = snapshot.extra
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra) }
    catch { throw new Error('Invalid XHTTP extra JSON') }
  }
  extra = { ...object(extra, 'XHTTP extra') }
  // Xray 的 URI extra 不决定上行 host/path/mode；这些字段以结构化节点为准。
  delete extra.host
  delete extra.path
  delete extra.mode
  const transport = { type: 'xhttp', ...buildXhttpOptions([opts, extra]) }
  const download = field([opts], 'download_settings')
  if (download != null || extra.downloadSettings != null) {
    transport.download_settings = buildDownload(download, extra.downloadSettings)
  }
  return transport
}

const CommentJSON = await loadCommentJSON()
let config
try {
  config = CommentJSON.parse($content)
} catch (e) {
  // 探路阶段 $content 未定义抛的是 ReferenceError，原样重抛，
  // 让 Sub-Store 识别为探路失败后回退到正确作用域（与 template.js 行为一致）；
  // 真正的 JSON 语法错误则包装成可读信息。
  throw e instanceof SyntaxError
    ? new Error(`xhttp-inject: $content 不是合法 JSONC: ${e.message ?? e}`)
    : e
}

for (const outbound of config.outbounds || []) {
  if (!['vless', 'vmess'].includes(outbound.type)) continue
  const key = XHTTP_CACHE_PREFIX + JSON.stringify([
    outbound.tag, outbound.type, outbound.server, Number(outbound.server_port), outbound.uuid || '',
  ])
  const snapshot = scriptResourceCache.get(key)
  if (!snapshot) continue
  try {
    if (outbound.type === 'vless' && snapshot.encryption) outbound.encryption = snapshot.encryption
    if (snapshot.network === 'xhttp') outbound.transport = buildXhttpTransport(snapshot)
  } catch (error) {
    throw new Error(`xhttp-inject: 节点 ${outbound.tag}: ${error.message}`)
  }
}

$content = CommentJSON.stringify(config, null, 2)