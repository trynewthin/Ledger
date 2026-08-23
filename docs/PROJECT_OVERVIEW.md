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
                     └──> Book Core、插件、身份等命令
```

所有入口使用同一份 `{ command, payload, context }` 调用协议。`context.source` 和 `context.recorder` 由入口注入，不属于用户填写的账目字段。

Dispatcher 同时维护声明式能力目录：每个应用命令描述自身领域、动作、用途以及 CLI/HTTP/MCP 的自然绑定。HTTP 使用资源路由，CLI 使用子命令，MCP 使用 tool 名称，三者最终调用同一个 handler。领域服务不感知路由、子命令或 tool。

常驻 host 提供 socket RPC、插件管理和 worker 监护；CLI 在 host 不可达时会冷引导同一套内核直接执行。MCP 同样以独立冷引导进程运行。

## 3. 仓库地图

```text
packages/
  domain/             Entry 聚合、金额与方向、事件、仓储端口、内存实现
  kernel/             账务服务、Book/Config Core、Dispatcher、Registry、EventBus、插件宿主
  storage-sqlite/     Storage Core、SQLite 仓储、控制面元数据、迁移、整体导入导出
  host/               常驻宿主、socket RPC、L2 worker supervisor
  plugin-contract/    后端插件 ABI 与服务契约
  webui-contract/     UI 插件 ABI
  http-rpc/           统一协议的 HTTP 编解码
  webui-shell/        React 前端 shell 与浏览器 UI 插件宿主

plugins/
  core-types/         标签组、标签与账本标签绑定
  description/        每条账目的可选文本描述字段
  cli/                CLI 与冷引导/RPC 混合会话
  http/               L2 HTTP API worker
  webui/              L2 Web UI 静态资源与 API 网关
  webui-core-views/   记账、流水、详情 UI 插件
  dataviews/          多维统计 UI 插件
  user/               身份目录与 user 服务
  mcp/                stdio MCP 入口
```

## 4. 核心领域模型

`Entry` 是唯一聚合根，固定字段包括：

- `direction`：`income` 或 `expense`，统计的唯一方向依据。
- `amountMinor`：最小货币单位正整数，方向不通过正负号表达。
- `currency`：支持的 ISO 4217 货币码；多币种记录但不折算。
- `occurredAt` / `recordedAt`：业务发生时间和入库时间分别保存。
- `source` / `recorder`：调用来源和记录身份。
- `type`：可空的注册类型 key。
- `extra`：动态扩展字段值，数据本身不依赖插件存活。
- `schemaVersion` / `revision`：迁移锚点和修订版本。
- `voidedAt` / `voidReason`：软作废状态。

核心不变量集中在 `packages/domain`。修订会保留修改前完整前像；物理删除不属于业务能力。账本不是 Entry 字段，而是由 Book Core 管理的完整项目状态。

## 5. 核心能力

统一命令面目前包含：

- 账目：`entry.add/get/list/revise/void/revisions`
- 统计：`stats.summary/monthly/byType/byDirection/byRecorder`
- 元数据：`type.register/list/get`、`field.register/list/get`
- 账本：`book.create/list/get/current/delete/switch`
- 标签插件：`tag-group.*`、`tag.*`、`book.tag.bind/list/unbind`
- 插件服务：`user.get/list`
- 管理：`plugin.*`、`host.info/shutdown`、`commands.list`

`commands.describe` 返回完整能力目录。HTTP 插件据此编译 REST 路由，例如：

| 应用命令 | HTTP | CLI | MCP |
|---|---|---|---|
| `entry.add` | `POST /entries` | `ledger add` | `add_entry` |
| `entry.list` | `GET /entries` | `ledger list` | `list_entries` |
| `entry.revise` | `PATCH /entries/:id` | `ledger revise` | `revise_entry` |
| `entry.void` | `POST /entries/:id/void` | `ledger void` | `void_entry` |
| `stats.summary` | `GET /stats/summary` | `ledger stats summary` | `get_stats` |
| `book.create` | `POST /books` | `ledger book create` | — |
| `book.switch` | `POST /books/:id/switch` | `ledger book switch` | — |

`POST /rpc` 继续提供统一协议的直接入口；REST 和 RPC 共享错误模型与业务实现。

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

插件平台的后续目标见 [演进目标](./EVOLUTION_GOALS.md)。

## 7. 数据与运行目录

仓库根目录的 `ledger.config.json` 是统一配置入口，样例见 `ledger.config.example.json`。执行 `ledger init` 或 `ledger config init` 会在当前项目根创建配置，并运行核心与已安装 L1 插件声明的初始化器。配置文件不参与提交；相对路径以仓库根目录解析。Config Core 提供不可变快照、校验、订阅和文件热加载，无效更新会保留上一份有效配置。

默认 `storage.dataDir` 是项目根目录下的 `.ledger/`。Storage Core 初始化该目录中的 SQLite 数据库、控制面数据库、账本目录、插件目录、UI 插件目录、快照和备份目录，并将 `.ledger/` 写入项目 `.gitignore`。该启动级配置发生变化时会标记 `restartRequired`，重启后切换目录。`LEDGER_HOME` 仅保留为测试和一次性运行覆盖。

Storage Core 管理共享 SQLite 连接、事务、组件迁移、账本内插件命名空间 KV、项目控制面 KV，以及整体导入导出和原生快照工件。领域 Repository 继续负责 Entry 等业务数据映射；Storage Core 不解释业务语义。

Book Core 是唯一的账本业务边界。`book create` 将当前 SQLite 业务状态、仓库根配置和插件启用清单保存为一个账本；`book switch` 恢复它们并要求常驻 host 重启，以重建全部插件运行态。`storage.dataDir` 是定位账本控制面的启动锚点，切换时保持不变。账本目录和跨账本标签位于 Storage Core 控制面，不随账本本体回退。

## 8. 快速运行

要求 Node.js 22+ 和 pnpm。

```bash
pnpm install
pnpm build
node plugins/cli/dist/cli.js init

# 零插件冷引导记账
node plugins/cli/dist/cli.js add -d expense -a 12.50

# 安装账本标签插件
node plugins/cli/dist/cli.js plugin install plugins/core-types
node plugins/cli/dist/cli.js book create "家庭账本"

# 安装账目描述核心插件
node plugins/cli/dist/cli.js plugin install plugins/description
node plugins/cli/dist/cli.js add -d expense -a 12.50 --description "周末采购"

# 启动常驻宿主
node plugins/cli/dist/cli.js host
```

Web UI 还需安装 `plugins/webui`，并安装 `webui-core-views/dist` 和可选的 `dataviews/dist` UI 插件；默认地址为 `http://127.0.0.1:7420`。

## 9. 开发与验证

```bash
pnpm build
pnpm -r --no-bail test
pnpm typecheck
```

测试覆盖纯领域、Book Core 状态切换、配置热加载、SQLite 迁移、整体导入导出、零插件门禁、插件生命周期、真实 socket/worker/HTTP、CLI 端到端、Web UI 网关、MCP 与身份目录。

修改现有能力前先阅读 [功能开发驾驭工程指南](./FEATURE_DEVELOPMENT_GUIDE.md)。

## 10. 已知边界

- 系统是个人本地工具，插件没有签名、沙箱和权限审计。
- `entry.list` 当前使用 limit/offset，不是游标分页。
- 账本切换后的常驻 host 需要重启；运行态插件实例不在快照中保留。
- user 是身份目录，不是认证与授权系统。
- 多币种不做汇率换算和本位币报表。

## 11. 历史文档

- [原始产品需求](./archive/PRD.md)
- [原始架构设计与决策记录](./archive/ARCHITECTURE.md)
- [M0–M6 实施进度与踩坑记录](./archive/PROGRESS.md)

历史文档用于追溯，不再作为当前开发导航；发生差异时，以当前代码、contract 和本目录下三份主文档为准。
