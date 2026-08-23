# Ledger 功能开发驾驭工程指南

> 本文用于修改现有产品能力或增加跨层功能。目标是快速判断改动落点，并保持零插件自洽、统一协议和多入口同源。

## 1. 开始前建立基线

1. 阅读 [项目概要](./PROJECT_OVERVIEW.md)，确认需求是否属于当前产品边界。
2. 执行 `git status --short --branch`，识别并保留已有改动。
3. 运行最接近改动位置的测试，确认修改前基线。
4. 为用户可观察行为先补失败测试，再实现最小改动。
5. 完成后执行受影响包测试、全量测试、typecheck 和 build。

全量验收命令：

```bash
pnpm build
pnpm -r --no-bail test
pnpm typecheck
```

## 2. 先判断功能应该落在哪里

| 需求性质 | 首要落点 | 判断标准 |
|---|---|---|
| Entry 永久业务不变量 | `packages/domain` | 没有任何插件时也必须成立 |
| 账目用例、统计、统一命令 | `packages/kernel` | 所有入口需要共享同一语义 |
| 数据持久化或查询能力 | `packages/storage-sqlite` + domain port | 属于核心 Entry/元数据持久化 |
| 无业务配置加载和热更新 | Config Core | 只提供配置事实，不解释消费者行为 |
| 无业务轻量数据、事务、导入导出 | Storage Core | 只提供持久化机制，不返回业务聚合结果 |
| 新的通信入口 | 后端插件 | 只是把外部协议转换为统一命令 |
| 类型、动态字段、可选业务能力 | L1 插件 | 卸载后核心账目仍然有效 |
| 有 server 或高风险 IO | L2 worker 插件 | 需要故障隔离和独立重启 |
| 页面、widget、详情面板 | UI 插件 | shell 不应承载业务视图 |
| 跨插件复用能力 | `plugin-contract` 服务契约 + provider 插件 | 消费方需要稳定的结构契约 |

禁止通过“某个入口先实现一份”来定义业务语义。CLI、MCP、HTTP 和 Web UI 都应调用 dispatcher；入口只负责参数解析、协议转换和结果展示。

## 3. 识别一次功能的完整变更面

一项功能通常沿以下链路传播：

```text
领域不变量
  → domain port / DTO
  → kernel service
  → dispatcher command
  → plugin-contract / webui-contract
  → CLI、MCP、HTTP、Web UI
  → 持久化与迁移
  → 分层测试和端到端测试
```

不是每项需求都会触及全部层。只有共享语义变化才更新 contract；不要为了单一消费者预建抽象或扩展点。

## 4. 修改领域模型

适用于金额规则、Entry 状态转换、修订和作废语义等零插件也必须成立的行为。

1. 在 `packages/domain/src/*.test.ts` 写出不变量的正反例。
2. 修改 `EntryData`、输入类型或值对象。
3. 在构造和状态转换函数中统一执行校验。
4. 同步内存仓储或 domain port。
5. 检查 plugin-contract 与 webui-contract 的序列化 DTO 是否需要同步。
6. 运行 domain、kernel 和 storage 测试。

领域层不得导入 Node API、SQLite、HTTP、Zod、插件 contract 或 UI 类型。时间、来源和 recorder 的默认值由应用层注入，不应隐藏在聚合根中。

## 5. 增加核心用例或命令

适用于新的核心查询、统计或 Entry 操作。

1. 在 `packages/kernel/src/ledger.test.ts` 或专用测试中定义业务结果。
2. 在 `LedgerService` 实现共享用例。
3. 在 `packages/kernel/src/validation.ts` 定义外部 payload 校验。
4. 在 `packages/kernel/src/commands.ts` 注册稳定命令名和能力描述。
5. 通过 `Dispatcher.dispatch()` 验证成功和类型化错误结果。
6. 按需接入 CLI、MCP 和 UI，但不复制业务计算。

命名约定为 `<领域>.<动作>`，例如 `entry.list`、`stats.byRecorder`。命令 handler 接收 payload 和由 dispatcher 组装的 `CallContext`。

能力描述至少包含 `name`、`domain`、`action` 和 `description`，按需声明：

```ts
{
  name: 'entry.add',
  domain: 'entry',
  action: 'add',
  description: '记录一笔账目',
  exposure: {
    cli: { command: 'add' },
    http: { method: 'POST', path: '/entries', successStatus: 201 },
    mcp: { tool: 'add_entry' },
  },
}
```

HTTP 路由保持资源语义，CLI/MCP 保持各自自然名称。不要机械地把 `entry.add` 暴露成 `/entry.add`，也不要让外部协议名称进入领域服务。

新增命令时还应检查：

- `commands.list` 是否可发现该命令。
- `commands.describe` 是否包含正确的领域与协议绑定。
- 冷引导和常驻 RPC 两条路径是否等价。
- HTTP REST 与 `/rpc` 是否得到相同业务结果和错误码。
- HTTP 状态映射是否需要新增错误码处理。
- MCP tool 是否需要即时暴露该能力。
- UI 是否通过 `LedgerClient.call()` 使用同一命令。

## 6. 修改存储和迁移

核心数据表变化按以下顺序实施：

1. 先扩展 domain port，避免内层依赖具体 SQLite。
2. 在 `packages/storage-sqlite/src/migrations.ts` 追加新版本，不修改已经发布的迁移语义。
3. 在单个事务中执行每版迁移。
4. 更新 row 与领域对象之间的双向映射。
5. 覆盖空库、新库和旧版本升级路径。
6. 验证索引与主要过滤条件一致。

不要物理删除账目，不要让统计反查插件表恢复历史语义。简单插件状态优先使用 `host.storage` 的 owner 命名空间；结构化插件数据通过插件 Repository 映射。只有核心模型需要的数据才进入核心 Repository。

Storage Core 的整体导入采用“检查兼容性 → 安全备份 → 同一事务逐表替换”。按账本合并、ID 冲突或 revision 续写属于业务语义，继续由 snapshot 等上层插件实现。

完整 SQLite 快照是 Storage Core 的基础能力：创建、列出、删除和切换。核心快照不包含保留策略、调度或账本粒度；这些能力由上层插件按需扩展。

## 7. 修改配置核心

1. 配置结构保持 JSON 可序列化。
2. Config Core 只实现发现、解析、合并、校验、路径规范化、快照和订阅。
3. 消费模块负责解释配置并决定是否重建自身资源。
4. 新配置必须先完整校验，再原子替换当前快照。
5. 热加载失败必须保留上一份有效快照并记录 `lastError`。
6. `storage.dataDir` 等启动级路径变化只标记 `restartRequired`。
7. 插件读取路径必须加入 `manifest.config.reads`。
8. 新增配置项时同步 `ledger.config.example.json` 和相关开发文档。

项目初始化由 `ledger init`（别名 `ledger config init`）执行：Config Core 创建根配置，Storage Core 先准备 `storage.dataDir`，随后已安装的 L1 插件可以运行自己注册的幂等初始化器。初始化器只创建项目资源或基础设施数据，不应创建业务账目。

## 8. 增加动态类型或字段

如果需求只是新增账目分类、图标、枚举或动态表单字段，通常不应修改 Entry 表结构。

1. 用插件的 `manifest.contributes` 或 `host.registry.registerType/registerField` 注册定义。
2. 保持 type key 全局稳定；层级子类型使用明确前缀避免冲突。
3. 字段值写入 `Entry.extra`，定义写入统一注册表。
4. 验证 scope、valueType、enumValues 和严格模式。
5. 验证插件卸载后历史条目仍可查询和统计。
6. 验证 CLI flag、MCP schema 和 Web UI 表单均从注册表获得定义。

同 owner 重复注册用于幂等刷新；不同 owner 的 key 冲突应显式失败，不能静默覆盖。

## 9. 增加或修改入口

入口层只负责四件事：

1. 把外部输入转换为 dispatcher payload。
2. 注入正确的 `source` 和 `recorder`。
3. 调用统一命令。
4. 把 `RpcResult` 转换为协议或界面输出。

CLI 使用 `Session.call()`，以保证 socket RPC 与冷引导透明切换。HTTP 入口应复用 `packages/http-rpc`。MCP schema 中的类型和字段应在请求时从注册表重建。Web UI 应通过 `LedgerClient` 调用命令。

入口不得直接访问 SQLite，也不得重新实现统计、类型方向校验或 Entry 状态转换。

## 10. 修改 Web UI

先判断改动属于 shell 还是 UI 插件：

- 布局、路由、插件加载、全局 client 和宿主状态属于 `packages/webui-shell`。
- 记账、流水、详情、统计和设置业务视图属于 UI 插件。

UI 插件通过以下扩展点贡献能力：

- `registerPage`：路由页面和侧边导航。
- `registerWidget`：Dashboard 卡片。
- `registerPanel`：Entry 详情附加区块。

新增 UI DTO 时，保持 `webui-contract` 自包含且与后端序列化形态结构兼容。不要让它依赖 `plugin-contract`，也不要在浏览器包中引入 Node 运行时能力。

## 11. 维护错误模型

预期业务失败必须使用稳定错误码：

- domain 不变量抛 `DomainError`。
- kernel 应用错误抛 `AppError`。
- dispatcher 统一转换为 `{ ok: false, error: { code, message, details? } }`。
- 入口保留错误码，只转换展示或 HTTP status。

缺少可选插件服务时使用 `SERVICE_UNAVAILABLE` 明确降级。不要吞掉错误并返回空结果，也不要把业务失败都折叠为 `INTERNAL`。

## 12. 测试分层

| 测试层 | 主要证明 |
|---|---|
| domain 单测 | 不变量和值对象行为 |
| kernel 单测 | 用例、注册表、错误码、零插件闭环 |
| storage 测试 | SQL 映射、过滤、修订、迁移 |
| config/storage core 测试 | 热加载、无效回退、命名空间隔离、整体导入原子性 |
| plugin 单测 | 注册、服务、卸载后数据有效性 |
| host 集成测试 | socket、L1 reload 回滚、L2 自动重启 |
| CLI/MCP/WebUI 端到端 | 用户入口与统一协议一致 |

`packages/kernel/src/zero-plugin.test.ts` 是永久门禁。任何核心改动都不得让基础记账依赖插件存在。

测试中的预期错误日志不等于失败；应以 Vitest 退出码和断言结果为准。

## 13. 常见陷阱

- `verbatimModuleSyntax` 开启后，类型必须使用 `import type`。
- CLI/host/MCP 入口构建必须关闭 tsup splitting，避免直跑入口判断失效。
- L1 热替换要求单文件 bundle；不要产生依赖相对 chunk 的安装态产物。
- 不要用 URL query 作为模块 cache bust；现有 loader 使用唯一临时文件名。
- UI 插件必须 externalize React、JSX runtime 和 webui-contract，保证浏览器只有一份 React。
- 安装态插件不能依赖仓库 node_modules 中的原生模块。
- 测目录穿越时要使用能发送原始路径的客户端；fetch 会预先规范化 `../`。
- `extra` 修订是整体替换，不是隐式 merge。
- 多币种统计必须分币种聚合，不能直接相加。

更多历史原因见 [归档进度文档的踩坑记录](./archive/PROGRESS.md#5-踩坑记录恢复时先读都是已消耗的时间)。

## 14. 完成定义

一项功能只有同时满足以下条件才算完成：

1. 行为在正确层实现，没有入口层业务复制。
2. 零插件核心仍然成立。
3. contract 和 DTO 仅在必要时同步。
4. 数据变更有向前迁移与升级测试。
5. 类型化错误贯穿所有受影响入口。
6. 动态类型和字段保持多入口同源。
7. 新行为有最低层单测和至少一条用户可观察链路证明。
8. `pnpm build`、全量测试和 typecheck 全部通过。
9. README、项目概要或相应工程指南已同步。
10. 新增基础设施代码在并发、原子性、回退等关键位置包含解释设计原因的注释。
