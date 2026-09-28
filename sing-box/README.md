# Starlark 配置与 Sub-Store

此仓库的 `template.js`、`xhttp-inject.js`、根目录 `psn-inject.js` 是互相独立的 Sub-Store 文件脚本操作。三者均使用 `comment-json` 修改对象后输出 JSONC，保留模板中附着在数组元素、键、冒号后的 `/* @starlark … */` 注释。`gen_config.js` 已弃用；把入站与脚本直接写在模板文件中，不要再通过它把两份配置重新序列化。

## 在 Sub-Store 中配置

1. 运行 `npm ci && npm run build && npm test`。`dist/comment-json.bundle.mjs` 是构建产物，不纳入 Git；将它和 `dist/THIRD_PARTY_LICENSES.txt` 一起作为 Release 附件发布。
2. 新建一个名为 **`comment-json`** 的 Sub-Store「文件」，类型使用普通文件（不要使用 mihomo 配置类型）。本地内容粘贴上述构建产物，或把远程 URL 指向 Release 中同一构建产物。三个脚本默认通过 `produceArtifact({ type: 'file', name: 'comment-json' })` 获取它；脚本参数 `commentJsonFile` 可覆盖文件名。
3. 模板文件应是完整的 sing-box JSONC 配置，含所需 `inbounds` 与 `outbounds`。按原顺序使用 `template.js` → `xhttp-inject.js` → `psn-inject.js`（按需启用后两者）。这些脚本不要求相互依赖，只有使用 `xhttp-prep.js` 时才需要在配置生成后执行 `xhttp-inject.js`。
4. 默认信任你管理的 Sub-Store 文件。需要校验时，给每个使用该文件的脚本传 `commentJsonSha256`（64 位十六进制）；可用 `sha256sum dist/comment-json.bundle.mjs` 获取。校验失败会报错，不会回退到丢失注释的 JSON 序列化。升级库时重新构建、测试并更新 Sub-Store 文件即可；使用了可选哈希时再同步更新参数。

**运行环境：**已针对 Sub-Store Node 后端的动态 `import(data:)` 验证；启用哈希时还需要 `require('node:crypto')`。非 Node 脚本环境未经验证。文件中仍可有 JSONC 注释和尾随逗号，但应遵守 sing-box fork 的 Starlark 标记语法；`comment-json` 不会校验脚本内容。不要用 Sub-Store 后续的整份 `JSON.parse`/`JSON.stringify`、或 sing-box `format`，否则会丢失或拒绝脚本。
