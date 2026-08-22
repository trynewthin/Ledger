# Ledger · 实施进度与恢复指南

> 持续更新的工作文档。目的：任何时刻可从本文恢复上下文，继续实施。
>
> 配套文档：[PRD.md](./PRD.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

## 1. 当前状态（2026-08-23）

| 里程碑 | 内容 | 状态 | 提交 |
|---|---|---|---|
| M0 | 仓库骨架 + 工具链 | ✅ 验收通过 | `02ce686` |
| M1 | domain + storage-sqlite + kernel + plugin-core-types | ✅ 验收通过 | `3247db3` |
| M2 | plugin-cli（双路径、动态 flag、admin） | ✅ 验收通过 | `ebcf14f` |
| M3 | host + L1 热替换回滚 + L2 supervisor + plugin-http | ✅ 验收通过 | `356af45` |
| M4 | plugin-webui（shell + UI 插件宿主 + core-views + http-rpc 抽出） | ✅ 验收通过 | `2505a7c` |
| M5 | plugin-mcp + 错误模型贯穿 + 迁移演练 + backup | ✅ 验收通过 | `6ab3fed` |
| **M6** | **plugin-user → core-types 完全体 → dataviews → snapshot** | ⏳ **未开始（下一步）** | — |

- 测试基线：**69 个测试全绿**，typecheck 全绿
- 每个里程碑的流程 = 实现 → `pnpm build && pnpm -r --no-bail test && pnpm typecheck` 全绿 → git 提交（规范见 git log）
- 工作树干净，HEAD 在 M5

## 2. 验证命令

```bash
pnpm build        # 全部包构建（含前端 vite）
pnpm -r --no-bail test   # 全部测试（不因单包失败中断）
pnpm typecheck    # 全部类型检查
```

注意事项：

- `packages/host`、`plugins/webui`、`plugins/mcp` 的测试较慢（真实进程/worker/socket），单包跑：`cd <pkg> && npx vitest run`
- 运行单个 CLI：`LEDGER_HOME=/tmp/x node plugins/cli/dist/cli.js add -d expense -a 12.50`
- 宿主前台运行：`LEDGER_HOME=/tmp/x node plugins/cli/dist/cli.js host`（CLI 自动切 RPC 路径）
- WebUI：安装并加载 plugin-webui 后 `http://127.0.0.1:7420`（环境变量 `LEDGER_WEBUI_PORT`；plugin-http 默认 7400，`LEDGER_HTTP_PORT`）
- MCP：`node plugins/mcp/dist/main.js`（stdio JSON-RPC，LEDGER_HOME 定位数据）

## 3. 已实现结构速览

```
packages/
  plugin-contract/   插件 ABI（HostAPI/AdminHostAPI/RPC 形态/DTO/manifest/definePlugin）
  webui-contract/    UI 插件 ABI（UiPlugin/UiHostAPI + 内核 DTO 镜像，零依赖）
  domain/            Entry 聚合、Money、ULID、事件、ports + 内存实现（零 IO）
  kernel/            错误模型、EventBus、Registry（三来源/unavailable）、
                     Services、LedgerService、Dispatcher、PluginHost（L1 load/
                     loadFile/reload 回滚）、loader（唯一文件名 bust）、
                     plugin-fs（安装管理 + UI 插件目录）、kernel 组装、命令注册
  storage-sqlite/    WAL、迁移框架（V1 全 DDL + V2 recorder 索引）、两仓储实现
  host/              常驻宿主：socket-server、worker（L2 引导 + postMessage RPC 桥）、
                     supervisor（退避重启/优雅停机/forceKill）、admin 门面、组装
  http-rpc/          统一调用协议 HTTP 编码/解码（statusForErrorCode 等）
  webui-shell/       Vite+React19+Tailwind v4+zustand；import map 外置 react
                     （public/vendor/*）；shell 零业务视图；UI 插件宿主 loader
                     （启停/热替换失败保留旧版）
plugins/
  core-types/        L1 基础类型（M6 升完全体）
  cli/               ledger bin：混合会话、全套命令、ledger host / backup / ui *
  http/              L2 worker：POST /rpc（经 http-rpc）
  webui/             L2 worker：serve shell + /api/rpc + UI 插件文件（safeJoin 防穿越）
  webui-core-views/  UI 插件：记账表单（注册表驱动同源渲染）/流水/详情+修订+作废
  mcp/               冷引导 stdio JSON-RPC；tool schema 即时从注册表构建
```

统一调用协议命令面（dispatcher）：`entry.add/get/list/revise/void/revisions`、`stats.summary/monthly/byType/byDirection`、`type.register/list/get`、`field.register/list/get`、`plugin.list/load/unload/reload/install/uninstall/update`（admin 注入时全集）、`host.info/shutdown`、`commands.list`。

## 4. 关键实现决策（对文档的落地补充）

1. **会话抽象（CLI 混合模式）**：`plugins/cli/src/session.ts` —— 先 `tryRpcConnect(host.sock)`（400ms 超时），失败降级 `assembleColdKernel`（本地组装 + 已安装 L1 插件引导）。对命令层完全透明。
2. **AdminHostAPI 注入链**：kernel `PluginHost.isAdmin()` 按 `coreMaintainedPlugins` 白名单；`createKernel(config.pluginsAdmin/hostControl)` 由 host 包注入 admin 门面 → dispatcher 获得 `plugin.*`/`host.*` 全集命令；冷引导进程只有 `plugin.list/unload` 子集。
3. **L1 热替换实现**：`PluginHost.reload(name)` —— deactivate 旧实例（托管项反注册）→ `loadPluginFromDir(dir, {bust:true})` → 失败则重新 activate 旧实例回滚。**bust 用唯一文件名拷贝**（`index.hot-<pid>-<ts>.mjs`）而非 URL query——见踩坑 #5。
4. **L2 worker 桥**：worker 线程内加载插件，HostAPI 经 postMessage RPC 代理（registry/ledger/dispatch/log/events 转发；services 不跨线程——worker 插件不参与插件间服务）。每 worker 全新模块注册表，L2 reload = 重启 worker。
5. **前端共享单副本**：shell 用 esbuild 打 vendor（react/react-dom/jsx-runtime/zustand/webui-contract → `public/vendor/*.js`），index.html import map 解析裸导入；UI 插件 vite lib mode 构建，`external: ['react', ...]`。shell 主 bundle 同样 external react。
6. **同 owner 注册幂等**：`Registry.registerType/registerField` 同 owner 重复注册 = 幂等刷新（插件跨进程反复激活），不同 owner 冲突才报 `TYPE_KEY_TAKEN`。`overwrite` 仅留给用户入口覆盖自己。
7. **UI 插件目录**：`<home>/ui-plugins/<name>/`，`ui-plugin.json`（name/version/entry）；安装复制由 kernel `plugin-fs.ts` 的 `installUiPluginDir` 完成；CLI：`ledger ui install/uninstall/list`。
8. **MCP tool schema 即时构建**：`tools/list` 与 `tools/call` 每次重建（注册新字段立即反映，与 CLI flag/WebUI 表单同源）。
9. **迁移框架**：`schema_migrations` 表 + 事务逐版本应用；V2 = `idx_entries_recorder`。演练测试在 `packages/storage-sqlite/src/storage.test.ts`。
10. **backup**：`plugins/cli/src/backup.ts` 用 better-sqlite3 `db.backup(dest)`，`ledger backup [-o file]`。

## 5. 踩坑记录（恢复时先读，都是已消耗的时间）

1. **`verbatimModuleSyntax: true`**：类型导入必须 `import type {...}`，否则 tsup dts 失败。逐个修过 domain/kernel/storage 的全部类型导入。
2. **`pnpm add` 参数含空格会写坏 package.json**（曾生成 `"domain@workspace:*": "link: @ledger/domain@workspace:*"`）。修复后必须检查 package.json 再 build。
3. **tsup 代码分割破坏直跑引导**：chunk 里的 `import.meta.url` ≠ 入口路径 → `isDirectRun` 永假，CLI 静默无输出。**入口类包（cli/host/mcp）`splitting: false`**。
4. **双 shebang**：源码手写 `#!/usr/bin/env node` + tsup banner 再加一个 → SyntaxError。shebang 只能来自 banner。
5. **URL query cache-bust 在 vite-node 下失效**：vitest 的模块加载钩子会归一化 `?t=` 查询参数，带 bust 的动态 import 仍命中旧模块。**L1 热替换改用唯一文件名拷贝**（`loader.ts`），任何缓存机制下可靠。配套：loader 的动态 import 加 `/* @vite-ignore */`；`packages/host`、`plugins/webui` 的 `vitest.config.ts` 将 `@ledger/*` 设为 external（原生 ESM 加载 dist）。
6. **`resolve(base, '/abs')` 逃逸**：`safeJoin` 里 `normalize('/'+rel)` 遇绝对路径直接返回后者，越出 base → 全部 404/穿越。正确写法：先 `replace(/^\/+/,'')` 再 resolve + startsWith 校验（`plugins/webui/src/index.ts`）。
7. **fetch 折叠 `../`**：测目录穿越不能用 fetch（undici 预规范化路径），用原生 `http.request` 发原始路径。
8. **插件安装过滤器**：`installPluginDir` 的 cp filter 需保留：plugin.json、`dist/`、`shell/`（webui 前端产物）、`assets/`、根级 `*.mjs/.js/.json/.css/.html`（测试插件是根级 index.mjs）。
9. **坏插件不能拖垮宿主**：`bootstrapInstalledPlugins` 逐个 try/catch，失败记入 `failed[]` 继续。
10. **commander 子命令组**：`type add`/`type list` 必须先 `program.command('type')` 再挂子命令，直接用带空格的命令名会冲突。
11. **CLI `--json`**：在 `runCli` 预扫描剥离，不注册为 commander option（避免逐命令注册）。
12. **无外部依赖的 ULID**：domain/src/ulid.ts 自实现（Crockford base32 + 同毫秒单调递增），不要引入 ulid 包。
13. **webui-core-views 的产物断言**：vite lib mode 未压缩，import 语句带空格（`from "react"` 而非 `from"react"`）。
14. **registry 在测试中的快捷访问**：`kernel.pluginHost.deps.registry`（HostApiDeps 暴露）；AppError 断言用 `(e as {code?}).code`，`.toThrow(/CODE/)` 匹配的是 message 不含 code。

## 6. M6 待办（下一步，按序实施与提交）

按 PRD/ARCHITECTURE：**plugin-user → plugin-core-types 完全体 → plugin-dataviews → plugin-snapshot**，每个完成后跑全量验收，M6 可整体一次提交或分四次提交（建议分四次，沿用现有提交规范）。

### 6.1 plugin-user（L1 + 服务提供者）

- 位置：`plugins/user/`（骨架已存在，src 只有占位 index）
- 数据：`users` 表已在 V1 DDL（id/name/kind: human|bot/is_default/created_at）——用 better-sqlite3 直接读写（内核无感知，插件自带表访问；参考 storage-sqlite 的用法，经 host.meta.dataDir 定位 db）
- manifest：`{ name: 'plugin-user', isolation: 'inprocess', provides: ['user'] }`
- activate：
  - 首次启动种子默认用户 `me`（is_default=1）
  - `host.services.provide('user', {...})`：服务面至少 `getUserId(): string`（当前默认身份）、`getUser(id)`、`listUsers()`、`setUserName(id, name)`（可按需加）
  - 注册命令（dispatcher 目前无 user.*；可经插件用 `host.dispatch`？——注意：插件没有直接注册 dispatcher 命令的 API。**方案**：经 kernel 增加一个通用机制或在 host 侧挂命令。最简单合契约的做法：把 user 查询命令注册进 dispatcher —— 建议在 kernel `commands.ts` 增加 `user.get/user.list` 转发到 services.get('user')，保持"管理入口不唯一"哲学；或者不动 kernel，webui 直接 `client.call('plugin.list')` 式扩展。**决策待定，倾向 kernel 加薄转发命令（约 10 行）**）
- 验收：装上后 `services.get('user')` 可用；webui 前端能显示访问者身份（经统一调用协议拿到当前用户名）；停用插件服务自动注销、消费方 `onAvailable` 收到通知；不装时其他插件降级（recorder 回退 `me`）

### 6.2 plugin-core-types 完全体（L1）

- 类型层级：大类型 + 小类型（`parentKey`，DDL 已有列；Registry/commands 已支持 parentKey 传参）
- lucide 图标：`icon` 字段已在贡献与 DDL
- 付款平台等枚举字段：**field_defs 注册**（`payment_platform` enum: alipay/wechat/bank/cash + 图标），scope both
- 升级 `plugins/core-types/src/index.ts` 的 TYPES 数组为层级结构（大： 餐饮/交通/购物/居住/娱乐/医疗/人情/教育…；小： 餐饮→ 咖啡/外卖/买菜…），并在 activate 里加 registerField
- 验收：`type list` 可见层级与图标；WebUI 记账表单类型下拉按层级分组、付款平台下拉出现（同源）；统计 byType 正常

### 6.3 plugin-dataviews（UI 插件 + 内核侧查询）

- 位置：`plugins/dataviews/`（骨架存在）
- 形态：UI 插件（同 webui-core-views 的构建方式：vite lib mode + ui-plugin.json + external react）；内核侧无需新命令——`stats.monthly/byType/byDirection` + `entry.list`（recorder 维度聚合可前端算或加 `stats.byRecorder`——若加则动 kernel/ledger.ts 四个纯函数之一 + commands 注册，成本低）
- 贡献：`registerWidget`（月度趋势条形、类型分布、付款平台分布、recorder 维度）到概览页；图表用纯 div/CSS 条形即可（不引图表库，马的标尺）
- 验收：WebUI 概览页出现数据视图卡片；多维过滤可用

### 6.4 plugin-snapshot（L1 + 服务提供者）

- 位置：`plugins/snapshot/`
- 两种粒度：
  - 全库：复用 SQLite backup（参照 `plugins/cli/src/backup.ts`），输出 `<home>/snapshots/<ts>.db`
  - 账本级：按 `book_id` 导出 JSON（entries + revisions + 相关 type/field defs）
- 回迁：全库 = 文件替换（需宿主配合：替换前关 db → copy → 重开，或提示重启宿主）；账本级 = 导入 JSON（生成新 id 或按原 id upsert——保留原 id + revision 续写）
- 命令：`snapshot.create/list/restore`（kernel commands 薄转发或插件内实现 + dispatcher 注册问题同 6.1 的决策）；CLI 子命令 `ledger snapshot create/restore/list`
- provides: ['snapshot']
- 验收：创建全库快照 → 记几笔 → 回迁到快照 → 数据回到快照点；账本级同理；单文件即备份单元

### 6.5 收尾

- README 状态段更新（实施完成、快速上手命令）
- PRD 第 7 节里程碑表打勾状态（可选）
- 最终全量验收：build + test + typecheck + git log 检查

## 7. 恢复检查清单

1. `git log --oneline` 确认 HEAD；`git status` 应干净
2. `pnpm install && pnpm build && pnpm -r --no-bail test && pnpm typecheck` 全绿基线（69 tests）
3. 读本文第 5 节踩坑记录（避免重蹈）
4. 从第 6 节继续 M6；每完成一个插件：全量验收 → 提交（规范：`M6(x/4): plugin-xxx ...` 或并入一次 M6 提交）
