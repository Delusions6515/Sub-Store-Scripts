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

const { type, name, includeUnsupportedProxy } = $arguments
const compatible_outbound = {
  tag: 'COMPATIBLE',
  type: 'direct',
}

let compatible
const CommentJSON = await loadCommentJSON()
let config
try {
  config = CommentJSON.parse($files[0])
} catch (error) {
  throw error instanceof SyntaxError
    ? new Error(`template: invalid JSONC input: ${error.message}`)
    : error
}

// —— 缓存：produceArtifact 结果缓存 6h，刷新窗口由链首清道夫控制 ——
const cache = scriptResourceCache
const cacheKey = `sb-artifact:${type}:${name}:${includeUnsupportedProxy}`
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6h

let proxies = cache.get(cacheKey)
if (!proxies) {
  proxies = await produceArtifact({
    name,
    type: /^1$|col/i.test(type) ? 'collection' : 'subscription',
    platform: 'sing-box',
    produceType: 'internal',
    produceOpts: {
      'include-unsupported-proxy': includeUnsupportedProxy,
    },
  })
  cache.set(cacheKey, proxies, CACHE_TTL)
}
// —— 缓存结束 ——

config.outbounds.push(...proxies)

filterTypes = ["direct", "selector", "urltest", "loadbalance", "smart", "dns"]
configProxies = filterGroup(config.outbounds, filterTypes)

config.outbounds.forEach(i => {
  if (['🤖 AI-!cn'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies, /^(?!.*(?:!送中!|!失败!)).*/i))
  }
  if (['🗺️ all', '🗺️ all-smart', '🗺️ all-auto', '🤖 AI-!cn'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies))
  }
  if (['🇭🇰 hk', '🇭🇰 hk-smart', '🇭🇰 hk-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies, /^(?!.*(?:!送中!|!失败!)).*(香港|Hong\s*Kong|\bHK\b)/i))
  }
  if (['🇯🇵 jp', '🇯🇵 jp-smart', '🇯🇵 jp-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies, /^(?!.*(?:!送中!|!失败!)).*(日本|川日|东京|大阪|泉日|埼玉|沪日|深日|关东|关西|\bJP\b|Japan)/i))
  }
  if (['🇹🇼 tw', '🇹🇼 tw-smart', '🇹🇼 tw-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies, /^(?!.*(?:!送中!|!失败!)).*(台湾|台北|新北|彰化|深台|穗台|\bTW\b|Taiwan)/i))
  }
  if (['🇸🇬 sg', '🇸🇬 sg-smart', '🇸🇬 sg-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies, /^(?!.*(?:!送中!|!失败!)).*(新加坡|狮城|星洲|\bSG\b|\bSGP\b|Singapore)/i))
  }
  if (['🇺🇸 us', '🇺🇸 us-smart', '🇺🇸 us-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies, /^(?!.*(?:!送中!|!失败!)).*(美国|美洲|波特兰|达拉斯|俄勒冈|凤凰城|费利蒙|硅谷|拉斯维加斯|洛杉矶|圣何塞|圣克拉拉|西雅图|芝加哥|纽约|加州|\bUS\b|_US_|-US-|\bUSA\b|United\s*States)/i))
  }
  if (['🇨🇳 送中-balance', '🇨🇳 送中-smart'].includes(i.tag)) {
    i.outbounds.push(...getTags(configProxies, /!送中!|!失败!/i))
  }
})

config.outbounds.forEach(outbound => {
  if (Array.isArray(outbound.outbounds) && outbound.outbounds.length === 0) {
    if (!compatible) {
      config.outbounds.push(compatible_outbound)
      compatible = true
    }
    outbound.outbounds.push(compatible_outbound.tag);
  }
});

$content = CommentJSON.stringify(config, null, 2)

function getTags(proxies, regex) {
  return (regex ? proxies.filter(p => regex.test(p.tag)) : proxies).map(p => p.tag)
}

function filterGroup(outbounds, types) {
  return (outbounds ? outbounds.filter(o => !types.includes(o.type)) : outbounds)
}
