// 注入 domain_resolver：读取 mihomo 订阅的 dns.proxy-server-nameserver，
// 生成 sing-box DNS server（必要时 group），并注入到对应节点的 outbound
//
// 支持多个提供商（每个都需要私有 DNS）：
//   $arguments.providers 为 JSON 字符串 / Sub-Store 文件引用，每项：
//     psnSub    - mihomo 订阅名（必填）
//     psnTag    - 生成的 DNS server / group 的 tag 前缀（默认 psn，多提供商请各自指定不同值）
//     psnPrefix - 节点 tag 前缀过滤（默认 `${psnSub} / `，可按实际格式自定义）
//     detour    - 可选，DNS 查询走的出站 tag（如 Proxy / Direct），留空则直连
//     psn       - 可选，手动指定 proxy-server-nameserver（用 | 分隔多个），优先于从订阅读取
//
// providers 的两种写法：
//   1. JSON 字符串：providers = '[{"psnSub":"YOUR_PROVIDER","psnTag":"psn"}]'
//   2. Sub-Store 文件内部路径：providers = 'file:文件名' 或 '/api/file/文件名'（本地文件，内容为 JSON 数组）
//   可选 providersType = 'string' | 'file' | 'auto'（默认 auto 自动判断：先试 JSON，失败再按文件找）
//
// 单提供商写法：$arguments.psnSub ($arguments 直接为 $arguments.providers[0])
// 可选 psnTag / psnPrefix / detour / psn
//
// mihomo DNS 写法覆盖: system / 裸IP / udp:// tcp:// tls:// https:// quic:// dhcp://
// 附加参数: #h3 #skip-cert-verify 生效; #proxy/#interface/#RULES 保留原 DNS 但舍弃该参数
//   （要 DNS 走代理请用 detour 参数）; #ecs 等无对应字段，忽略
//
// hosts: 读取订阅的 hosts 段，追加到 tag=hosts 的 DNS server（无则创建；不覆盖已有键；
//   通配符键跳过——sing-box hosts server 只做精确匹配）。
// 新增 DNS server 的域名解析：hostname 命中 hosts 且非 TLS 类型（udp/tcp）时直接用 hosts IP 替换；
//   其余（TLS 类换 IP 会破坏 SNI/证书校验，或不在 hosts）用 domain_resolver='local'。
//   注：sing-box 的 dns group 取首个响应，hosts 对未列域名回 NXDOMAIN 会抢先导致 local 永不生效，
//   因此不建 hosts+local 的 group。
const CommentJSON = await loadCommentJSON();

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

function loadProviders() {
  const fileRef = function (name) {
    const files = readArray('files');
    const f = files.find(function (x) { return x && x.name === name; });
    if (!f) throw new Error('providers file not found: ' + name);
    if (!f.content) throw new Error('providers file has no local content: ' + name);
    try { return JSON.parse(f.content); } catch (error) {
      throw new Error('providers file is not valid JSON: ' + (error.message || error));
    }
  };
  const asArray = function (v) {
    if (Array.isArray(v)) return v;
    let o;
    try { o = JSON.parse(v); } catch (error) {
      throw new Error('providers is not valid JSON: ' + (error.message || error));
    }
    return Array.isArray(o) ? o : [o];
  };
  let raw;
  if (Array.isArray($arguments)) return $arguments;
  if ($arguments && $arguments.providers !== undefined) raw = $arguments.providers;
  else if ($arguments && $arguments.psnSub) return [$arguments];
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  const type = ($arguments && $arguments.providersType) || 'auto';
  const s = String(raw).trim();
  if (s.indexOf('file:') === 0) return asArray(fileRef(s.slice(5)));
  if (s.indexOf('/api/file/') === 0) return asArray(fileRef(decodeURIComponent(s.split('/').pop())));
  if (type === 'file') return asArray(fileRef(s));
  if (type === 'string') return asArray(s);
  try { return asArray(s); } catch { /* 继续尝试文件 */ }
  try { return asArray(fileRef(s)); } catch {
    console.log('psn: providers 既不是 JSON 也不是文件: ' + s);
    return [];
  }
}

let providers = [];
try {
  providers = loadProviders();
} catch (e) {
  console.log('psn: load providers failed: ' + (e && e.message || e));
}

function isIP(v) {
  if (!v) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return true;
  if (v.indexOf(':') >= 0) return true; // IPv6
  return false;
}

// hosts predefined 里找 host 的 IP（精确匹配，忽略大小写）；值可能是 IP / IP 数组 / 域名，只取 IP
function pickHostsIP(hostsMap, host) {
  if (!hostsMap || !host) return null;
  const h = String(host).toLowerCase();
  let v = null;
  Object.keys(hostsMap).forEach(function (k) {
    if (!v && String(k).toLowerCase() === h) v = hostsMap[k];
  });
  if (!v) return null;
  if (Array.isArray(v)) return v.find(isIP) || null;
  if (typeof v === 'string' && isIP(v)) return v;
  return null;
}

// TLS 类 DNS server 换 IP 会破坏 SNI/证书校验，不能替换
function isTlsDnsType(type) {
  return type === 'https' || type === 'h3' || type === 'tls' || type === 'quic';
}

// read 可能返回数组 / JSON 字符串 / null / undefined，统一成数组
function readArray(key) {
  try {
    const raw = ($substore && $substore.read) ? $substore.read(key) : null;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* 读不到就当没有 */ }
  return [];
}

// mihomo DNS 地址 → sing-box DNS server 配置（不含 tag/detour/domain_resolver）
function mihomoDnsToServer(addr) {
  if (addr == null || addr === '') return null;
  const raw = String(addr).trim();
  const hashIdx = raw.indexOf('#');
  const base = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const params = {};
  if (hashIdx >= 0) {
    raw.slice(hashIdx + 1).split('&').filter(Boolean).forEach(function (p) {
      const eq = p.indexOf('=');
      if (eq >= 0) params[p.slice(0, eq)] = p.slice(eq + 1);
      else params[p] = true;
    });
  }
  if (base === 'system' || base === 'system://') return { type: 'local' };
  if (/^rcode:/.test(base)) return null; // sing-box 无 rcode 类型
  let scheme = '';
  let rest = base;
  const m = base.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);
  if (m) { scheme = m[1].toLowerCase(); rest = m[2]; }
  if (scheme === 'dhcp') {
    const server = { type: 'dhcp' };
    if (rest && rest !== 'system') server.interface = rest;
    return server;
  }
  let port = 0;
  let path = '';
  const slash = rest.indexOf('/');
  if (slash >= 0) { path = rest.slice(slash); rest = rest.slice(0, slash); }
  let host = rest;
  if (rest.charAt(0) === '[') {
    const close = rest.indexOf(']');
    if (close > 0) {
      host = rest.slice(1, close);
      const pm = rest.slice(close + 1).match(/^:(\d+)$/);
      if (pm) port = parseInt(pm[1], 10);
    }
  } else {
    const idx = rest.lastIndexOf(':');
    if (idx > 0 && /^\d+$/.test(rest.slice(idx + 1))) {
      host = rest.slice(0, idx);
      port = parseInt(rest.slice(idx + 1), 10);
    }
  }
  if (!host) return null;
  let type = scheme || 'udp';
  if (params.h3) type = 'h3';
  const server = { type: type, server: host };
  if (port) server.server_port = port;
  if ((type === 'https' || type === 'h3') && path) server.path = path;
  if (params['skip-cert-verify']) server.insecure = true;
  return server;
}

try {
  const config = CommentJSON.parse($content);
  for (const cfg of providers) {
    if (!cfg || !cfg.psnSub) continue;
    const psnSub = cfg.psnSub;
    const psnTag = cfg.psnTag || 'psn';
    const psnDetour = cfg.detour || '';
    const psnPrefix = cfg.psnPrefix || psnSub + ' / ';
    let psnList = [];
    let psnSource = '';
    let doc = null;
    if (cfg.psn) {
      // 1. 手动指定优先
      psnList = String(cfg.psn).split('|').map(function (s) { return s.trim(); }).filter(Boolean);
      psnSource = 'manual';
    } else {
      // 2. 订阅原始内容：produceType=raw 在跑订阅的 process 链之前返回，
      //    避免该订阅自身也启用本脚本时递归调用；
      //    includeRaw 同时给出 context.raw 对应的未预处理内容，本地/远程订阅都能读到完整 mihomo yaml（含 dns 段）
      try {
        const { raw } = await produceArtifact({
          type: 'subscription',
          name: psnSub,
          produceType: 'raw',
          includeRaw: true,
        });
        if (!Array.isArray(raw)) throw new Error('需要 Sub-Store 2.42.4 及以上版本支持 includeRaw');
        const text = raw.filter(function (i) { return typeof i === 'string' && i.length > 0; })[0];
        if (text) doc = yaml.load(text);
      } catch (e) {
        console.log('psn[' + psnSub + ']: 读取订阅原始内容失败: ' + (e && e.message || e));
      }
      if (doc && doc.dns) {
        if (doc.dns['proxy-server-nameserver']) {
          psnList = doc.dns['proxy-server-nameserver'];
          psnSource = 'proxy-server-nameserver';
        } else if (doc.dns.nameserver) {
          // mihomo 语义：proxy-server-nameserver 为空时遵循 nameserver
          psnList = doc.dns.nameserver;
          psnSource = 'nameserver (fallback)';
        }
        if (!Array.isArray(psnList)) psnList = [psnList];
      }
    }
    if (psnSource) console.log('psn[' + psnSub + ']: dns source = ' + psnSource);
    const dns = config.dns || (config.dns = {});
    dns.servers = dns.servers || [];
    const existing = {};
    dns.servers.forEach(function (s) { if (s && s.tag) existing[s.tag] = true; });
    // tag 冲突时自动加后缀
    const freeTag = function (want) {
      let tag = want;
      let n = 1;
      while (existing[tag]) { tag = want + '-' + (n++); }
      return tag;
    };
    // hosts: 追加到 tag=hosts 的 dns server（无则创建），predefined 合并，不覆盖已有键，通配符键跳过
    let hostsMap = null;
    if (doc && doc.hosts && typeof doc.hosts === 'object') {
      let hostsServer = dns.servers.find(function (s) { return s && s.tag === 'hosts'; });
      if (!hostsServer) {
        hostsServer = { type: 'hosts', tag: 'hosts' };
        dns.servers.push(hostsServer);
        existing['hosts'] = true;
      }
      if (!hostsServer.predefined || typeof hostsServer.predefined !== 'object') hostsServer.predefined = {};
      let added = 0;
      Object.keys(doc.hosts).forEach(function (k) {
        if (k.indexOf('*') >= 0) {
          console.log('psn[' + psnSub + ']: hosts 通配符键 ' + k + ' 无法在 sing-box hosts server 精确匹配, 跳过');
          return;
        }
        if (hostsServer.predefined[k] !== undefined) return; // 不覆盖已有
        hostsServer.predefined[k] = doc.hosts[k];
        added++;
      });
      if (added > 0) console.log('psn[' + psnSub + ']: hosts 合并 ' + added + ' 条 -> tag=hosts');
      hostsMap = hostsServer.predefined;
    }
    const servers = (psnList || []).map(mihomoDnsToServer).filter(Boolean);
    if (servers.length === 0) continue;
    const entries = servers.map(function (s, i) {
      const tag = freeTag(servers.length > 1 ? psnTag + '-' + i : psnTag);
      const entry = Object.assign({ tag: tag }, s);
      if (psnDetour) entry.detour = psnDetour;
      if (!isIP(entry.server)) {
        // hosts 感知: hostname 命中 hosts 且非 TLS 类型时直接用 hosts IP；否则 local 解析
        const hostIP = pickHostsIP(hostsMap, entry.server);
        if (hostIP && !isTlsDnsType(entry.type)) {
          console.log('psn[' + psnSub + ']: ' + entry.server + ' -> hosts IP ' + hostIP);
          entry.server = hostIP;
        } else {
          entry.domain_resolver = 'local';
        }
      }
      existing[tag] = true;
      return entry;
    });
    entries.forEach(function (e) { dns.servers.push(e); });
    let resolverTag = entries[0].tag;
    if (servers.length > 1) {
      const groupTag = freeTag(psnTag);
      const group = { type: 'group', tag: groupTag, servers: entries.map(function (e) { return e.tag; }) };
      existing[groupTag] = true;
      dns.servers.push(group);
      resolverTag = groupTag;
    }
    (config.outbounds || []).forEach(function (o) {
      if (o && o.tag && o.tag.indexOf(psnPrefix) === 0 && o.server && !isIP(o.server) && !o.domain_resolver) {
        o.domain_resolver = resolverTag;
      }
    });
  }
  $content = CommentJSON.stringify(config, null, 2);
} catch (e) {
  console.log('psn: inject failed: ' + (e && e.message || e));
}
