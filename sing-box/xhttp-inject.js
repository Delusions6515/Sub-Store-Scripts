// xhttp-inject.js —— 响应端脚本，放在 template.js 之后
//
// 配合 sing-box/xhttp-prep.js（订阅 process 脚本）使用：
//   1. xhttp-prep.js 把 xhttp/splithttp 节点降级为 tcp 占位、抽走 VLESS
//      encryption，并将原始 xhttp-opts / encryption 存入 scriptResourceCache
//   2. 本脚本在 template.js 产出完整 sing-box 配置后，按 outbound.tag 读回
//      快照，还原 transport:{type:'xhttp',...} 并补回 encryption
//
// 挂载：文件 → 脚本操作 → Script 类型。parsing 由 produce 完成，这里直接裸写
//       $content（探路阶段自然抛 $content is not defined，由 Sub-Store 识别后
//       回退到正确作用域执行，与 template.js 行为一致）。
//
// 字段映射参考 sing-box docs/configuration/shared/v2ray-xhttp.md：
//   mode / host / path / headers 原样透传；其余 Sub-Store kebab-case → sing-box
//   snake_case。download-settings（Xray）与 reuse-settings（mihomo）为各自
//   客户端特有，sing-box 无对应字段，不输出。

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

const XHTTP_CACHE_PREFIX = 'xhttp-node:' // 与 xhttp-prep.js 一致

const KEBAB_TO_SNAKE = {
  'x-padding-bytes': 'x_padding_bytes',
  'no-grpc-header': 'no_grpc_header',
  'session-placement': 'session_placement',
  'session-key': 'session_key',
  'session-table': 'session_table',
  'session-length': 'session_length',
  'seq-placement': 'seq_placement',
  'seq-key': 'seq_key',
  'uplink-data-placement': 'uplink_data_placement',
  'uplink-data-key': 'uplink_data_key',
  'uplink-chunk-size': 'uplink_chunk_size',
  'uplink-http-method': 'uplink_http_method',
  'x-padding-obfs-mode': 'x_padding_obfs_mode',
  'x-padding-placement': 'x_padding_placement',
  'x-padding-key': 'x_padding_key',
  'x-padding-header': 'x_padding_header',
  'x-padding-method': 'x_padding_method',
}

function isPlainObject(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  )
}

function buildXhttpTransport(xhttpOpts) {
  const opts = isPlainObject(xhttpOpts) ? xhttpOpts : {}
  const transport = { type: 'xhttp' }

  const host = opts.host ?? opts.headers?.Host ?? opts.headers?.host
  if (host) transport.host = host
  if (opts.path && opts.path !== '') transport.path = opts.path
  if (opts.mode && opts.mode !== '') transport.mode = opts.mode

  const headers = isPlainObject(opts.headers) ? opts.headers : undefined
  if (headers && Object.keys(headers).length > 0) transport.headers = headers

  for (const [kebabKey, snakeKey] of Object.entries(KEBAB_TO_SNAKE)) {
    const value = opts[kebabKey]
    if (value != null && value !== '') transport[snakeKey] = value
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

for (const outbound of config.outbounds) {
  const snapshot = scriptResourceCache.get(`${XHTTP_CACHE_PREFIX}${outbound.tag}`)
  if (!snapshot) continue

  if (outbound.type === 'vless' && snapshot.encryption) {
    outbound.encryption = snapshot.encryption
  }
  if (snapshot.network === 'xhttp' || snapshot.network === 'splithttp') {
    outbound.transport = buildXhttpTransport(snapshot.xhttpOpts)
  }
}

$content = CommentJSON.stringify(config, null, 2)