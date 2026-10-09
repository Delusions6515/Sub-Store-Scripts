// Sub-Store 订阅/组合订阅 process 脚本，放在重命名等节点操作之后。
// 配合 template.js 后的 xhttp-inject.js：绕过 producer 对 XHTTP/Encryption 的拒绝。
// 仅修改 sing-box 目标；快照一次写入，避免 XHTTP 覆盖同节点的 Encryption。
// 运行端需要 with_xhttp，HTTP/3 还需要 with_quic。

const XHTTP_CACHE_PREFIX = 'xhttp-node:v2:'
const XHTTP_CACHE_TTL = 12 * 60 * 60 * 1000 // 须覆盖 template.js 的 6h 产物缓存

function cacheKey(proxy) {
  // shortcut: 同名且连接身份完全相同的节点共用快照，配置不同请先重命名。
  return XHTTP_CACHE_PREFIX + JSON.stringify([
    proxy.name, proxy.type, proxy.server, Number(proxy.port), proxy.uuid || '',
  ])
}

function operator(proxies, targetPlatform) {
  if (!['sing-box', 'singbox'].includes(String(targetPlatform || '').trim().toLowerCase()) || !Array.isArray(proxies)) {
    return proxies
  }
  for (const proxy of proxies) {
    if (!proxy?.name || !['vless', 'vmess'].includes(proxy.type)) continue
    const xhttp = ['xhttp', 'splithttp'].includes(proxy.network)
    const encrypted = proxy.type === 'vless' && proxy.encryption && proxy.encryption !== 'none'
    const key = cacheKey(proxy)
    if (!xhttp && !encrypted && !scriptResourceCache.get(key)) continue
    const snapshot = {}
    if (encrypted) snapshot.encryption = proxy.encryption
    if (xhttp) {
      snapshot.network = 'xhttp'
      snapshot.xhttpOpts = proxy['xhttp-opts'] ?? proxy['splithttp-opts'] ?? {}
      snapshot.extra = proxy._extra_unsupported ?? proxy._extra
    }
    // 普通节点也覆盖旧快照，防止取消 XHTTP/Encryption 后注入过期配置。
    try {
      const data = xhttp || encrypted ? JSON.parse(JSON.stringify(snapshot)) : null
      scriptResourceCache.set(key, data, XHTTP_CACHE_TTL)
    } catch (error) {
      throw new Error(`xhttp-prep: 无法缓存节点 ${proxy.name}: ${error.message}`)
    }
    if (encrypted) delete proxy.encryption
    if (xhttp) {
      proxy.network = 'tcp'
      delete proxy['xhttp-opts']
      delete proxy['splithttp-opts']
    }
  }
  return proxies
}
