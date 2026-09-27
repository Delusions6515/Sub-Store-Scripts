// xhttp-prep.js —— Sub-Store 订阅/组合订阅的 process 脚本
//
// 目的：让 sing-box 输出能用到 VLESS XHTTP 传输与 VLESS Encryption（后量子公钥），
//       且不改动 Sub-Store 后端源码。
//
// 背景：Sub-Store 内置的 sing-box producer 目前对这两个特性是硬性拒绝的：
//         sing-box.js:1453  network=xhttp  → throw "does not support network: xhttp"
//         sing-box.js:1556  vless encryption !== 'none' → throw "not supported"
//   所以订阅里一旦有 xhttp / PQ 加密节点，整个 sing-box 产物都会失败。
//
// 做法（两段式，配合 sing-box/xhttp-inject.js 使用）：
//   1. 本脚本（process，运行于 produce 之前）：
//        - 仅在目标平台是 sing-box 时生效（其他平台如 mihomo/stash 原生支持 xhttp，保持原样）
//        - 把 xhttp / splithttp 节点降级改写为 tcp（保留 server/uuid/tls/reality/flow 等）
//        - 抽走 vless 的非 none encryption
//        - 将原始 xhttp-opts / encryption 存入 scriptResourceCache，供 inject 端重建
//   2. sing-box/xhttp-inject.js（response，运行于 template.js 等产出步骤之后）：
//        - 按 outbound.tag 读回缓存，补上 transport:{type:'xhttp',...} 与 encryption
//
// 依赖：Sub-Store 在脚本环境中注入的 scriptResourceCache（后端单例，跨脚本共享）。
//       缓存 TTL 12h，需覆盖 template.js 对 produceArtifact 结果所做的 6h 缓存窗口。
//
// 挂载：Sub-Store 前端 → 订阅/组合订阅 → 脚本 → 添加 process 脚本，指向本文件。
//       注意：本脚本只服务 sing-box 目标；其余平台沿用原生 xhttp 输出，不受影响。
//
// 注意：sing-box 运行端需用 `-tags with_xhttp` 构建（XHTTP 仅客户端、需要该构建标签），
//       VLESS Encryption 是独立于 TLS/REALITY 的额外层，配置须与服务端一致。

const XHTTP_CACHE_PREFIX = 'xhttp-node:';
const XHTTP_CACHE_TTL = 12 * 60 * 60 * 1000; // 12h，须 > template.js 的 6h 产物缓存

const SING_BOX_TARGETS = ['sing-box', 'singbox'];

function isSingBoxTarget(targetPlatform) {
    const target = `${targetPlatform || ''}`.trim().toLowerCase();
    return SING_BOX_TARGETS.some((name) => target === name);
}

function cacheKey(name) {
    return `${XHTTP_CACHE_PREFIX}${name}`;
}

// 云端 URI 里 splithttp 会被 uri.js 归一为 xhttp；这里同样兼容处理。
function isXhttpNetwork(proxy) {
    return proxy && ['xhttp', 'splithttp'].includes(proxy.network);
}

function operator(proxies, targetPlatform) {
    if (!isSingBoxTarget(targetPlatform)) {
        return proxies;
    }
    if (!Array.isArray(proxies)) {
        return proxies;
    }
    for (const proxy of proxies) {
        if (!proxy || typeof proxy !== 'object' || !proxy.name) {
            continue;
        }
        if (!['vless', 'vmess'].includes(proxy.type)) {
            continue;
        }
        // —— VLESS Encryption（非 none）：抽走原值，避免 sing-box producer 抛错 ——
        if (proxy.type === 'vless' && proxy.encryption && proxy.encryption !== 'none') {
            const snapshot = {
                type: proxy.type,
                encryption: proxy.encryption,
            };
            scriptResourceCache.set(
                cacheKey(proxy.name),
                snapshot,
                XHTTP_CACHE_TTL,
            );
            delete proxy.encryption;
        }
        // —— XHTTP / splithttp：降级为 tcp 占位，保留 tls/reality/flow/uuid ——
        if (isXhttpNetwork(proxy)) {
            const xhttpOpts = proxy['xhttp-opts'] || {};
            const snapshot = {
                type: proxy.type,
                network: proxy.network,
                xhttpOpts,
            };
            if (proxy.encryption && proxy.encryption !== 'none') {
                snapshot.encryption = proxy.encryption;
            }
            scriptResourceCache.set(
                cacheKey(proxy.name),
                snapshot,
                XHTTP_CACHE_TTL,
            );
            proxy.network = 'tcp';
            delete proxy['xhttp-opts'];
        }
    }
    return proxies;
}