# Ledger 项目概要

> 本文是当前项目的主入口，描述已经落地的产品边界、系统结构和运行方式。
> 历史需求、架构决策和里程碑记录保存在 [`archive/`](./archive/README.md) 中。

## 1. 项目定位

Ledger 是一个本地优先的个人财务数据操作系统，而不是只绑定某个界面的记账应用。它由一套零插件即可工作的收支内核、一个微内核插件宿主和多个可替换入口组成。

当前面向单人、多记录身份（recorder）场景，不提供账号注册、多用户隔离、插件沙箱、汇率折算或插件市场。

四条设计原则决定所有实现取舍：

1. **内核自洽**：没有插件时仍能记账、修订、作废、查询和统计。
2. **数据自包含**：账目保存自身方向和扩展值；插件离线不使历史数据失效。
3. **插件深度信任**：插件可直接消费内核能力；仅插件管理能力使用白名单分级。
4. **依赖指向内层**：domain 不依赖 IO，插件面向稳定 contract 编译。

## 2. 系统心智模型

```text
CLI ───────┐
MCP ───────┤
HTTP ──────┼──> Dispatcher ──> LedgerService ──> EntryRepository ──> SQLite
Web UI ────┘         │                │
                     │                ├──> Registry（类型、动态字段）
                     │                └──> EventBus（领域事件）
                     └──> 插件、身份、快照等命令
```

所有入口使用同一份 `{ command, payload, context }` 调用协议。`context.source` 和 `context.recorder` 由入口注入，不属于用户填写的账目字段。

常驻 host 提供 socket RPC、插件管理和 worker 监护；CLI 在 host 不可达时会冷引导同一套内核直接执行。MCP 同样以独立冷引导进程运行。

## 3. 仓库地图

```text
packages/
  domain/             Entry 聚合、金额与方向、事件、仓储端口、内存实现
  kernel/             账务服务、Dispatcher、Registry、EventBus、插件宿主
  storage-sqlite/     SQLite 仓储、元数据存储、迁移
  host/               常驻宿主、socket RPC、L2 worker supervisor
  plugin-contract/    后端插件 ABI 与服务契约
  webui-contract/     UI 插件 ABI
  http-rpc/           统一协议的 HTTP 编解码
  webui-shell/        React 前端 shell 与浏览器 UI 插件宿主

plugins/
  core-types/         类型层级、图标、付款平台动态字段
  cli/                CLI 与冷引导/RPC 混合会话
  http/               L2 HTTP API worker
  webui/              L2 Web UI 静态资源与 API 网关
  webui-core-views/   记账、流水、详情 UI 插件
  dataviews/          多维统计 UI 插件
  user/               身份目录与 user 服务
  snapshot/           全库/账本级快照与恢复
  mcp/                stdio MCP 入口
```

## 4. 核心领域模型

`Entry` 是唯一聚合根，固定字段包括：

- `direction`：`income` 或 `expense`，统计的唯一方向依据。
- `amountMinor`：最小货币单位正整数，方向不通过正负号表达。
- `currency`：支持的 ISO 4217 货币码；多币种记录但不折算。
- `occurredAt` / `recordedAt`：业务发生时间和入库时间分别保存。
- `source` / `recorder`：调用来源和记录身份。
- `bookId`：当前默认 `default`，数据结构已预留多账本。
- `type`：可空的注册类型 key。
- `extra`：动态扩展字段值，数据本身不依赖插件存活。
- `schemaVersion` / `revision`：迁移锚点和修订版本。
- `voidedAt` / `voidReason`：软作废状态。

核心不变量集中在 `packages/domain`。修订会保留修改前完整快照；物理删除不属于业务能力。

## 5. 核心能力

统一命令面目前包含：

- 账目：`entry.add/get/list/revise/void/revisions`
- 统计：`stats.summary/monthly/byType/byDirection/byRecorder`
- 元数据：`type.register/list/get`、`field.register/list/get`
- 插件服务：`user.get/list`、`snapshot.create/list/restore`
- 管理：`plugin.*`、`host.info/shutdown`、`commands.list`

类型和字段注册表是 CLI 动态参数、MCP tool schema 与 Web UI 动态表单的共同事实源。新增注册字段后，不应在各入口重复维护同一份枚举或校验规则。

## 6. 插件模型

后端插件有三种运行形态：

| 形态 | 适用场景 | 生命周期 |
|---|---|---|
| L1 `inprocess` | 类型、字段、事件订阅、插件间服务 | 进程内加载；热替换失败回滚旧实例 |
| L2 `worker` | HTTP server、Web server、可能崩溃的 IO | worker 隔离；崩溃退避重启 |
| 冷引导进程 | CLI、MCP 等外部管理入口 | 每次启动重新装配内核 |

Web UI 内部还有独立的 UI 插件层。shell 只负责布局、路由和加载；业务页面与仪表盘 widget 由 UI 插件贡献。

具体开发约束见 [插件开发驾驭工程指南](./PLUGIN_DEVELOPMENT_GUIDE.md)。

## 7. 数据与运行目录

运行数据由 `LEDGER_HOME` 定位。主要内容包括 SQLite 数据库、已安装后端插件、UI 插件、插件配置和快照文件。生产仓储使用 `better-sqlite3`，启用 WAL，并通过 `schema_migrations` 逐版本事务迁移。

入口装配负责提供共享的 `db` 服务。需要 SQLite 的 L1 插件应消费该服务，不应把原生数据库驱动留作安装态运行依赖。

## 8. 快速运行

要求 Node.js 22+ 和 pnpm。

```bash
pnpm install
pnpm build

# 零插件冷引导记账
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js add -d expense -a 12.50

# 安装基础类型插件
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js plugin install plugins/core-types

# 启动常驻宿主
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js host
```

Web UI 还需安装 `plugins/webui`，并安装 `webui-core-views/dist` 和可选的 `dataviews/dist` UI 插件；默认地址为 `http://127.0.0.1:7420`。

## 9. 开发与验证

```bash
pnpm build
pnpm -r --no-bail test
pnpm typecheck
```

当前基线为 84 个测试。测试包含纯领域、SQLite 迁移、零插件门禁、插件生命周期、真实 socket/worker/HTTP、CLI 端到端、Web UI 网关、MCP、身份和快照恢复。

修改现有能力前先阅读 [功能开发驾驭工程指南](./FEATURE_DEVELOPMENT_GUIDE.md)。

## 10. 已知边界

- 系统是个人本地工具，插件没有签名、沙箱和权限审计。
- `entry.list` 当前使用 limit/offset，不是游标分页。
- 多账本存在于模型和过滤器中，但尚未形成完整产品入口。
- user 是身份目录，不是认证与授权系统。
- 多币种不做汇率换算和本位币报表。

## 11. 历史文档

- [原始产品需求](./archive/PRD.md)
- [原始架构设计与决策记录](./archive/ARCHITECTURE.md)
- [M0–M6 实施进度与踩坑记录](./archive/PROGRESS.md)

历史文档用于追溯，不再作为当前开发导航；发生差异时，以当前代码、contract 和本目录下三份主文档为准。
