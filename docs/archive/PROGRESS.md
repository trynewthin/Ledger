# Ledger · 实施进度与恢复指南

> 持续更新的工作文档。目的：任何时刻可从本文恢复上下文，继续实施。
>
> 配套文档：[PRD.md](./PRD.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)

## 1. 当前状态（2026-08-23）

**实施完成。** M0–M6 全部里程碑完成、验收并提交。

| 里程碑 | 内容 | 状态 | 提交 |
|---|---|---|---|
| M0 | 仓库骨架 + 工具链 | ✅ 验收通过 | `02ce686` |
| M1 | domain + storage-sqlite + kernel + plugin-core-types | ✅ 验收通过 | `3247db3` |
| M2 | plugin-cli（双路径、动态 flag、admin） | ✅ 验收通过 | `ebcf14f` |
| M3 | host + L1 热替换回滚 + L2 supervisor + plugin-http | ✅ 验收通过 | `356af45` |
| M4 | plugin-webui（shell + UI 插件宿主 + core-views + http-rpc 抽出） | ✅ 验收通过 | `2505a7c` |
| M5 | plugin-mcp + 错误模型贯穿 + 迁移演练 + backup | ✅ 验收通过 | `6ab3fed` |
| M6(1/4) | plugin-user + 'db'/'user' 服务契约 + user.* 薄转发 | ✅ 验收通过 | git log `M6(1/4)` |
| M6(2/4) | plugin-core-types 完全体（层级 + 图标 + payment_platform） | ✅ 验收通过 | git log `M6(2/4)` |
| M6(3/4) | plugin-dataviews（UI 插件）+ stats.byRecorder | ✅ 验收通过 | git log `M6(3/4)` |
| M6(4/4) | plugin-snapshot（全库/账本级快照 + 回迁） | ✅ 验收通过 | git log `M6(4/4)` |

- 测试基线：**84 个测试全绿**，typecheck 全绿
- 每个里程碑的流程 = 实现 → `pnpm build && pnpm -r --no-bail test && pnpm typecheck` 全绿 → git 提交（规范见 git log）

## 2. 验证命令

```bash
pnpm build        # 全部包构建（含前端 vite）
pnpm -r --no-bail test   # 全部测试（不因单包失败中断）
pnpm typecheck    # 全部类型检查
```

注意事项：

- `packages/host`、`plugins/webui`、`plugins/cli` 的测试较慢（真实进程/worker/socket），单包跑：`cd <pkg> && npx vitest run`
- 运行单个 CLI：`LEDGER_HOME=/tmp/x node plugins/cli/dist/cli.js add -d expense -a 12.50`
- 宿主前台运行：`LEDGER_HOME=/tmp/x node plugins/cli/dist/cli.js host`（CLI 自动切 RPC 路径）
- WebUI：安装并加载 plugin-webui 后 `http://127.0.0.1:7420`（环境变量 `LEDGER_WEBUI_PORT`；plugin-http 默认 7400，`LEDGER_HTTP_PORT`）
- MCP：`node plugins/mcp/dist/main.js`（stdio JSON-RPC，LEDGER_HOME 定位数据）
- 快照/身份：`ledger snapshot create/list/restore`、`ledger user get/list`（先 `plugin install plugins/snapshot` / `plugins/user`）

## 3. 已实现结构速览

```
packages/
  plugin-contract/   插件 ABI（HostAPI/AdminHostAPI/RPC 形态/DTO/manifest/definePlugin
                     + 'db'/'user'/'snapshot' 服务契约：SqliteDb/UserService/SnapshotService）
  webui-contract/    UI 插件 ABI（UiPlugin/UiHostAPI + 内核 DTO 镜像，零依赖）
  domain/            Entry 聚合、Money、ULID、事件、ports + 内存实现（零 IO）
  kernel/            错误模型、EventBus、Registry（三来源/unavailable）、
                     Services、LedgerService（stats 含 byRecorder）、Dispatcher、
                     PluginHost（L1 load/loadFile/reload 回滚）、loader（唯一文件名 bust）、
                     plugin-fs（安装管理 + UI 插件目录）、kernel 组装、命令注册
                     （entry/stats/type/field/user/snapshot/plugin/host/commands）
  storage-sqlite/    WAL、迁移框架（V1 全 DDL + V2 recorder 索引）、两仓储实现
  host/              常驻宿主：socket-server、worker（L2 引导 + postMessage RPC 桥）、
                     supervisor（退避重启/优雅停机/forceKill）、admin 门面、组装（提供 'db' 服务）
  http-rpc/          统一调用协议 HTTP 编码/解码（statusForErrorCode 等；503/404 映射）
  webui-shell/       Vite+React19+Tailwind v4+zustand；import map 外置 react
                     （public/vendor/*）；shell 零业务视图；UI 插件宿主 loader
                     （启停/热替换失败保留旧版）
plugins/
  core-types/        L1 完全体：大/小类型层级（parentKey，<parent>-<leaf> 前缀 key）
                     + lucide 图标 + payment_platform 枚举字段
  cli/               ledger bin：混合会话、全套命令、ledger host / backup / ui *
                     / user / snapshot；冷引导提供 'db' 服务
  http/              L2 worker：POST /rpc（经 http-rpc）
  webui/             L2 worker：serve shell + /api/rpc + UI 插件文件（safeJoin 防穿越）
  webui-core-views/  UI 插件：记账表单（层级分组下拉/注册表驱动）/流水/详情+修订+作废/身份显示
  dataviews/         UI 插件：概览页 4 widget（月度趋势/类型分布/付款平台/记录者），
                     纯 div/CSS 条形 + 方向/日期多维过滤；聚合纯函数单测
  user/              L1 + 服务提供者：users 表自带（经 'db' 服务）、种子 me、'user' 服务
  snapshot/          L1 + 服务提供者：全库 backup / 账本级 JSON、ATTACH 事务整表回迁、
                     账本级按原 id upsert（revision 续写）
  mcp/               冷引导 stdio JSON-RPC；tool schema 即时从注册表构建
```

统一调用协议命令面（dispatcher）：`entry.add/get/list/revise/void/revisions`、`stats.summary/monthly/byType/byDirection/byRecorder`、`type.register/list/get`、`field.register/list/get`、`user.get/list`、`snapshot.create/list/restore`、`plugin.list/load/unload/reload/install/uninstall/update`（admin 注入时全集）、`host.info/shutdown`、`commands.list`。

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
11. **'db' 服务（M6）**：L1 插件（user/snapshot）不自带原生依赖——安装到任意 LEDGER_HOME 的插件目录无法解析仓库内 node_modules 的 better-sqlite3。正解：**入口装配共享自己的连接**（`cold-boot.ts` / `host.ts` 经 `kernel.services.provide('db', db)`），插件消费 `SqliteDb` 结构子集（契约在 plugin-contract）。dist 零外部 import（tsup `noExternal: [/./]`），安装自包含。
12. **user.*/snapshot.* 薄转发（M6）**：dispatcher 命令转发到服务提供者插件；不在场 → `SERVICE_UNAVAILABLE`（明确降级而非静默）。服务层错误带 code（如 `SNAPSHOT_NOT_FOUND`），kernel 命令层 `withCode` 翻译进错误模型。
13. **类型层级 key（M6）**：小类型用 `<parent>-<leaf>` 前缀（`food-coffee`），避免与用户运行时注册的短 key 冲突（不同 owner 冲突是设计语义）。
14. **全库快照回迁（M6）**：不用文件替换（需关 db/重启宿主），改 **ATTACH + 单事务整表 DELETE+INSERT SELECT**——同连接内完成、失败自动 ROLLBACK、无需宿主配合；回迁后 kernel 命令层 `registry.load()` 重载内存注册表。账本级回迁 = 按原 id upsert（`INSERT OR REPLACE` entries + `INSERT OR IGNORE` revisions），revision 从快照续写。
15. **stats.byRecorder（M6）**：recorder 维度进内核纯函数（与 byType 同构），CLI/MCP/WebUI 同源；extra 字段维度（付款平台分布）留在前端聚合（entry.list），不给内核加 byExtra。

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
15. **注释里的 `*/` 序列**（M6）：块注释中写 `user.*/snapshot.*` 会提前终止注释 → esbuild 语法错误。星点组合与斜杠之间加空格。
16. **vitest 不解析动态 import 的未声明依赖**（M6）：`await import('@ledger/domain')` 在未声明 devDep 的包里直接失败（vite resolve 阶段）。用静态 import 并把依赖写进 devDependencies。
17. **安装态插件的原生依赖**（M6）：插件 dist 若 import better-sqlite3，安装到 `~/.ledger` 后模块解析必然失败。见决策 #11——入口经 'db' 服务共享连接，插件 dist 零外部 import。
18. **ATTACH 库的表存在性检查**（M6）：`sqlite_master` 是每库一张——检查 `snap.entries` 必须查 `snap.sqlite_master`，查主库 `sqlite_master` 里名为 `snap.entries` 的表永远为空（整表回迁被静默跳过）。

## 6. 后续可能的方向（非待办，仅备忘）

M6 完成后 PRD 范围已闭环。若继续演进，候选方向（均不破坏现有架构）：

- user：多用户切换（`LEDGER_RECORDER` 之外的默认身份切换命令）、bot 身份管理
- snapshot：快照保留策略（数量/时限清理）、自动定时快照（宿主侧）
- dataviews：预算对比 widget、导出 PNG/CSV
- kernel：`entry.list` 游标分页、stats 缓存
- webui：设置页（插件启停 UI 化）

## 7. 恢复检查清单

1. `git log --oneline` 确认 HEAD；`git status` 应干净
2. `pnpm install && pnpm build && pnpm -r --no-bail test && pnpm typecheck` 全绿基线（84 tests）
3. 读本文第 5 节踩坑记录（避免重蹈）
4. 实施已完成；新工作从第 6 节候选方向或 PRD 之外的新需求开始，流程沿用：实现 → 全量验收 → 提交
