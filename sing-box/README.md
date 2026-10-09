# Starlark 配置与 Sub-Store

此仓库的 `template.js`、`xhttp-inject.js`、根目录 `psn-inject.js` 是互相独立的 Sub-Store 文件脚本操作。三者均使用 `comment-json` 修改对象后输出 JSONC，保留模板中附着在数组元素、键、冒号后的 `/* @starlark … */` 注释。`gen_config.js` 已弃用；把入站与脚本直接写在模板文件中，不要再通过它把两份配置重新序列化。

## 在 Sub-Store 中配置

1. 运行 `npm ci && npm run build && npm test`。`dist/comment-json.bundle.mjs` 是构建产物，不纳入 Git；将它和 `dist/THIRD_PARTY_LICENSES.txt` 一起作为 Release 附件发布。
2. 新建一个名为 **`comment-json`** 的 Sub-Store「文件」，类型使用普通文件（不要使用 mihomo 配置类型）。本地内容粘贴上述构建产物，或把远程 URL 指向 Release 中同一构建产物。三个脚本默认通过 `produceArtifact({ type: 'file', name: 'comment-json' })` 获取它；脚本参数 `commentJsonFile` 可覆盖文件名。
3. 模板文件应是完整的 sing-box JSONC 配置，含所需 `inbounds` 与 `outbounds`。按原顺序使用 `template.js` → `xhttp-inject.js` → `psn-inject.js`（按需启用后两者）。这些脚本不要求相互依赖，只有使用 `xhttp-prep.js` 时才需要在配置生成后执行 `xhttp-inject.js`。
4. 默认信任你管理的 Sub-Store 文件。需要校验时，给每个使用该文件的脚本传 `commentJsonSha256`（64 位十六进制）；可用 `sha256sum dist/comment-json.bundle.mjs` 获取。校验失败会报错，不会回退到丢失注释的 JSON 序列化。升级库时重新构建、测试并更新 Sub-Store 文件即可；使用了可选哈希时再同步更新参数。

**运行环境：**已针对 Sub-Store Node 后端的动态 `import(data:)` 验证；启用哈希时还需要 `require('node:crypto')`。非 Node 脚本环境未经验证。文件中仍可有 JSONC 注释和尾随逗号，但应遵守 sing-box fork 的 Starlark 标记语法；`comment-json` 不会校验脚本内容。不要用 Sub-Store 后续的整份 `JSON.parse`/`JSON.stringify`、或 sing-box `format`，否则会丢失或拒绝脚本。

## VLESS XHTTP / Encryption

按当前 sing-box XHTTP / VLESS 配置字段生成出站。运行端必须支持下述字段，旧版 XHTTP 配置不能直接复用。

### 挂载与升级

- 订阅/组合订阅的 process 脚本：`xhttp-prep.js`，放在重命名、修改服务器等节点操作**之后**。只对 `sing-box` / `singbox` 目标生效，不影响其他平台。
- 配置文件的脚本操作：`template.js` → `xhttp-inject.js` → `psn-inject.js`（最后一个按需）。必须成对使用 prep/inject；TCP 占位节点不是可直接使用的最终配置。
- prep 一次缓存 XHTTP 和 Encryption，再删除 producer 不支持的字段；inject 按名称、协议、服务器、端口、UUID 匹配恢复。同名但不同连接身份的节点不会串用配置。同名且身份完全一致、但 XHTTP/TLS/Encryption 配置不同的节点仍须在 prep 前重命名；不同配置文件内的最终 outbound tag 也必须唯一。
- 快照使用 `xhttp-node:v2:` 前缀、12h TTL，覆盖 template 的 6h 产物缓存。`cleaner.js` 的原有前缀清理仍适用。普通节点再次经过 prep 会清除其旧特性快照。
- **升级时同步替换两个脚本，并清除旧快照和 TCP 占位产物缓存，再重新生成订阅。** 在同一个 Sub-Store 后端临时执行以下 process 脚本一次即可定向清理这两个前缀（24h 大于两类缓存 TTL）；不要只刷新最终文件，也不要在生成后单独清掉快照：

  ```js
  function operator(proxies) {
    scriptResourceCache._cleanup('sb-artifact:', 24 * 60 * 60 * 1000)
    scriptResourceCache._cleanup('xhttp-node:', 24 * 60 * 60 * 1000)
    return proxies
  }
  ```

### 字段转换

- 接受 `xhttp-opts`，兼容 `splithttp` / `splithttp-opts`；支持 Sub-Store kebab-case、sing-box snake_case，以及 `_extra_unsupported` / `_extra` 中保留的 Xray camelCase 字段。结构化节点字段优先于残留 extra；URI extra 内的上行 host/path/mode 不覆盖结构化字段。
- `session-table` / `session-length` 转为 `session_id_table` / `session_id_length`；不再输出旧 `session_table` / `session_length` 或已移除的 `sc_max_concurrent_posts`。支持新版 `no_sse_header`、`sc_*`、`server_max_header_bytes`、`user_agent`、QUIC 参数。
- `Host` 请求头（大小写不敏感）移到 `host`，从 `headers` 删除；已有显式 host 优先。host 可为字符串或数组，逗号分隔的列表转为数组；其他请求头保留。
- `reuse-settings` 转为 `xmux`，包括五个 range 字段和以秒为单位的 `h_keep_alive_period`。range 使用 int32 整数或区间字符串；旧 `[from, to]` / `{ from, to }` 转为区间字符串，其他非法形状报错。不会主动填充核心默认值，省略与空 XMUX 仍交给核心处理。
- `download-settings` 转为 `download_settings`，支持服务器/端口、TLS/REALITY、SNI、ALPN、证书验证开关、uTLS、ECH，以及独立 XHTTP 参数。原生 `download_settings` 中的 TLS 对象和文档中的 dial 字段保留。无法安全转换的旧证书指纹会报错，请改用原生 TLS 证书校验字段。
- **下载的 path/host/headers/padding/XMUX/TLS 不继承上行。** server/port 和空 dialer 的回退由 sing-box 核心处理；这与 mihomo 对 `download-settings` 的继承行为不同，迁移时请显式填写需要的下载参数。
- Encryption 字符串原样恢复，格式与密钥验证由核心负责：`mlkem768x25519plus.<native|xorpub|random>.<0rtt|1rtt>.[padding.]<client key>`。空值或 `none` 不启用。使用 `sing-box generate vless-encryption` 生成对应密钥；旧客户端字符串中的会话寿命参数不能混入新格式。Encryption 是独立于 TLS/REALITY 的一层；启用后 Vision 可用于任意传输且不要求 TLS，本脚本不改写 flow。

运行端需包含 `with_xhttp`；HTTP/3 还需要 `with_quic`，并在相应连接上配置 TLS/ALPN。脚本只生成出站，不生成 XHTTP 入站或 VLESS decryption。

### 验证

`npm test` 覆盖 prep/inject、缓存隔离、字段映射、独立下载和 JSONC/Starlark 保留。设置 `SING_BOX_XHTTP_BIN` 为最新带 `with_xhttp` 的二进制，可运行真实配置检查；设置 `SING_BOX_BIN` 可同时运行 Starlark render 检查：

```sh
SING_BOX_XHTTP_BIN=/path/to/sing-box SING_BOX_BIN=/path/to/sing-box npm test
```

这些检查不证明真实 Xray/CDN 服务端连接、吞吐或握手兼容性。
