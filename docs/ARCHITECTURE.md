# Ledger · 技术架构文档

> 版本 v1.0 · 2026-08-22 · 状态：已确认定稿
>
> 配套文档：[PRD.md](./PRD.md)（产品需求）

## 1. 第一原则

所有设计决策的裁判依据，冲突时以此排序：

1. **内核自洽**：零插件时系统完整可用。`direction`（income/expense）是内核语义，统计只依赖它，永不查插件表。`type` 在数据结构上可空
2. **数据自包含**：direction 与扩展字段的值冗余落在每条 Entry。插件卸载/崩溃后数据仍在，注册表标记 `unavailable` 而非静默消失
3. **插件广职权、深度信任**：普通插件直接持有内核 HostAPI，与内核内部模块同权限，无签名、无沙箱、无审计
4. **能力分级**：插件管理能力是独立能力面（AdminHostAPI），仅白名单核心维护插件可获得；管理入口不唯一
5. **依赖箭头永远向内**：domain 零 IO；插件只编译依赖 `plugin-contract`；contract 即本系统的 ABI，版本纪律高于一切

## 2. 架构总览

微内核 + 双形态运行：

```
                         ┌───────────── host（常驻宿主）─────────────┐
                         │  kernel                                    │
   CLI ──socket 通→RPC──►│   ├─ 插件宿主 + 统一注册表 + 事件总线       │
   （混合自动模式）        │   ├─ dispatcher：统一调用协议              │
      │socket 不通        │   └─ supervisor                            │
      ↓冷引导             │  L1 进程内插件: plugin-core-types           │
   本地组装内核+插件       │  L2 worker 插件: plugin-http / plugin-webui│
   （与 host 同一内核）    │  domain ◄─ storage-sqlite                  │
                         └───────────────┬────────────────────────────┘
                                         │ webui worker
   浏览器 ◄──HTTP──► plugin-webui（L2，前后端一体）
                      ├─ serve webui-shell 产物 + API 网关（统一调用协议 over HTTP）
                      └─ 前端 shell 内自成 UI 插件宿主：
                         webui-core-views 等 UI 插件在浏览器内动态加载/启停

   MCP ──被客户端 spawn，stdio──► 冷引导独立进程（同 CLI 的组装方式）

   plugin-cli / plugin-mcp：冷引导进程，具备 AdminHostAPI（白名单）
```

- **双形态，同一内核**：host 常驻（热更新、局部重引导发生地）；CLI/MCP 冷引导（加载→执行→退出）。内核代码完全相同，只是组装方式不同
- **统一调用协议贯穿进程内外**：dispatcher 的 `{ command, payload, context }` 格式同时用于进程内直调与 CLI↔host 的 socket RPC；业务命令与 admin 命令同一通道（如 `entry.add`、`plugin.reload`）

## 3. 包结构与依赖规则

```
packages/
  plugin-contract/     # 插件 API 纯类型 + 最小运行时；插件唯一编译依赖（ABI）
  webui-contract/      # UI 插件 API 纯类型；UI 插件唯一编译依赖（前端 ABI），零依赖
  domain/              # Entry 聚合、Money/Direction 值对象、领域事件、仓储接口
                       # 纯 TS，零 IO，零协议依赖
  kernel/              # 插件宿主、统一注册表、dispatcher、事件总线、
                       # 错误模型、能力面（白名单）、supervisor
  storage-sqlite/      # 仓储实现（better-sqlite3 + WAL）、迁移框架
  host/                # 常驻宿主：组装、本地 socket 服务、L1 热替换回滚、L2 监护
  http-rpc/            # 统一调用协议的 HTTP 编码/解码（非内核，纯工具包）
                       # M4 引入 webui 时从 plugin-http 抽出（不为单一消费者预建共享包）
  webui-shell/         # 前端宿主：Vite + React + Tailwind v4 + shadcn/ui + zustand
                       # 布局/路由/UI 插件宿主/内核 client（调用协议 over HTTP）
plugins/
  core-types/          # L1：类型体系（基础收支语义起步 → 大/小类型层级 + 图标 + 付款平台字段）
  cli/                 # 冷引导 + RPC 双路径，AdminHostAPI
  webui/               # L2（前后端一体）：serve shell 产物 + API 网关 + UI 插件文件
  webui-core-views/    # UI 插件：记账表单/流水/详情（最小可用）——shell 零业务视图；
                       # 统计图表不在内，归 plugin-dataviews
  user/                # L1 + 服务提供者：users 表与 user 服务（userId/用户名，供前端与后续插件）
  dataviews/           # 数据视图：UI 插件 + 内核侧多维查询
  snapshot/            # 快照：全库/账本级备份与回迁
  mcp/                 # 冷引导独立进程，stdio
  http/                # L2 worker，纯 API 入口（程序化访问）
```

依赖方向（唯一规则，箭头向内）：

```
plugins ──► plugin-contract
webui 插件 ──► webui-contract
host ──► kernel ──► domain ◄── storage-sqlite（实现 domain 仓储接口，依赖倒置）
plugin-http / plugin-webui ──► http-rpc
```

- `domain` 不 import 任何 IO / 协议 / 框架库
- `plugin-contract` 不依赖包内任何其他包；第三方插件只依赖它
- 测试中仓储换内存实现，domain/kernel 全程可纯单测

## 4. 插件系统

### 4.1 契约（plugin-contract，系统的 ABI）

```ts
export interface LedgerPlugin {
  manifest: PluginManifest;
  activate(host: HostAPI | AdminHostAPI): Promise<void>;
  deactivate(ctx: { reason: 'reload' | 'shutdown' | 'crash' }): Promise<void>;
}

export interface PluginManifest {
  name: string;                       // 'plugin-core-types'
  version: string;
  isolation: 'inprocess' | 'worker';  // L1 / L2（冷引导进程由入口自身决定）
  capabilities?: ('admin')[];         // 声明意图；实际授权以内核白名单为准
  provides?: string[];                // 向其他插件提供的服务名，如 ['user']
  consumes?: string[];                // 消费的其他插件服务；可选依赖，缺失时插件自行降级
  contributes?: {
    types?: TypeContribution[];       // { key, label, direction, parentKey?, icon?, schema? }
    fields?: FieldContribution[];     // { key, label, scope, valueType, enumValues? }
  };
}
```

### 4.2 能力面（轻量权限分级）

```ts
export interface HostAPI {              // 所有插件获得
  registry: RegistryAPI;               // registerType/registerField/...（托管项随 deactivate 自动反注册）
  events: EventBusAPI;                 // subscribe（自动退订）
  ledger: LedgerAPI;                   // addEntry/reviseEntry/voidEntry/query/stats
  services: ServicesAPI;               // 插件间服务（见 4.6）
  log: Logger;
  meta: { pluginName: string; dataDir: string };
}

export interface AdminHostAPI extends HostAPI {   // 仅白名单插件获得
  plugins: PluginAdminAPI;             // list/status/load/unload/reload/install/uninstall/update
  host: HostControlAPI;                // info/shutdown
}
```

- 授权机制：内核配置 `coreMaintainedPlugins: ['plugin-cli', ...]`；activate 时白名单内传 `AdminHostAPI`，否则只传 `HostAPI`。无令牌、无签名、无运行时审计——这是"轻量"的边界
- 管理能力属于内核而非 CLI：将来任何特权插件（如 host 的管理端点）可消费同一 PluginAdminAPI

### 4.3 插件三级形态

| 级别 | 形态 | 适用 | 热更新方式 |
|---|---|---|---|
| L1 | 进程内模块 | 纯逻辑注册型（type/field），高频深度调用 | 注销注册项 → 清模块缓存 → 重载 → 重注册；**失败自动回滚旧版本** |
| L2 | worker thread / 子进程 | 有 IO、有 server、可能崩溃（HTTP） | drain → kill → restart → 重新接线；supervisor 崩溃退避重启，宿主与其他插件全程存活 |
| 冷引导 | 独立一次性/客户端管理进程 | CLI、MCP（被外部 spawn） | 进程重启即重引导；MCP 由客户端重连实现 |

L1 热替换的纪律：插件必须无状态，注册表是其唯一外部出口，否则旧模块引用泄漏。不做执行中函数级热替换（BEAM 的领域，Node 里"秒级局部重引导"即优雅上限）。

### 4.4 冷引导下的 admin 语义

CLI 双路径中 admin 能力的语义差异：

- **RPC 路径**（宿主在）：全部 admin 命令作用于运行中的宿主——load/reload 立即生效（触发 L1/L2 热更新）
- **冷引导路径**（宿主不在）：install/uninstall/update 可用（本质是文件 + 配置操作）；load/reload 提示"需宿主运行"（对一次性进程无意义）

### 4.5 WebUI：分形插件架构

WebUI 是内核的 L2 插件（前后端一体），其前端 shell 内部又是一个 UI 插件宿主——同一套插件哲学在浏览器里重演，故称**分形**：

**后端（跑在 host 的 L2 worker 内）**：

- serve `webui-shell` 的构建产物（静态资源）
- API 网关：统一调用协议 over HTTP（复用 `http-rpc` 包），`{ command, payload, context }` 的 HTTP 编码——CLI 的 RPC 路径、plugin-http、WebUI 前端三者共享同一协议
- UI 插件文件服务：扫描 UI 插件目录（manifest + ESM 产物 + 资源），serve 在 `/plugins/<name>/`；`/api/ui-plugins` 返回清单
- supervisor 重引导：webui worker 崩溃由 host 拉起，浏览器侧重连

**前端（webui-shell，浏览器内）**：

- 技术栈：Vite + React + Tailwind CSS v4 + shadcn/ui + zustand（全局状态：内核数据缓存 + UI 插件注册表）
- 自身零业务视图：空 shell 只提供布局、路由框架、插件管理页——零 UI 插件时可运行（分形版第一原则）
- 启动时拉取 UI 插件清单 → 动态 import 各插件 ESM → activate → 贡献物入注册表；路由与布局从注册表渲染

**UI 插件契约（webui-contract 包，前端 ABI，镜像 plugin-contract 纪律）**：

```ts
export interface UiPlugin {
  manifest: { name: string; version: string; contributes?: UiContribution[] };
  activate(host: UiHostAPI): Promise<void>;
  deactivate(): Promise<void>;
}

export interface UiHostAPI {
  registry: {
    registerPage(key: string, component: PageComponent): void;      // ui.page：路由页面
    registerWidget(key: string, component: WidgetComponent): void;  // ui.widget：仪表盘卡片
    registerPanel(key: string, component: PanelComponent): void;    // ui.panel：Entry 详情附加区块
  };  // 托管项随 deactivate 自动反注册，React 树自然卸载
     // 扩展点种类按需增加（settings、command…），机制不变——不预建空扩展点
  client: LedgerClientAPI;  // 内核调用代理（统一调用协议 over HTTP），无特权通道
  store: ZustandStoreRef;   // 读取 shell 全局状态（只读切片）
}
```

**UI 插件的加载与热替换**：生产态动态 import 后端 serve 的 ESM（URL 加 cache-busting 参数即得新模块，重新 activate + 反注册旧贡献物）；开发态 vite dev server 直接 import 本地插件目录。前端热替换无模块缓存问题，语义上等同内核 L1 的"注销-重载-重注册"，且天然不需要回滚（失败即保留旧版本继续运行）。

**同源动态表单**：`webui-core-views` 的记账表单从 field_defs/type_defs 驱动渲染——enum → 下拉、date → 日期选择器、number → 数字输入；与 CLI flag 生成、MCP tool schema 生成同源。注册一个新字段，全部入口同时获得支持。

### 4.6 插件间服务与核心插件全景

**插件间服务（轻量服务模型）**：核心插件的职责不止"验证机制可行"——它们是必要功能，且为后续插件开发提供基础能力（如 userId）。机制：

```ts
export interface ServicesAPI {
  provide<T>(name: string, service: T): void;       // 登记，随 deactivate 自动注销
  get<T>(name: string): T | undefined;              // 提供者未激活时返回 undefined
  onAvailable(name: string, cb: () => void): void;  // 服务就绪/失效通知（自动退订）
}
```

- 宿主按 `provides/consumes` 声明做拓扑排序加载
- `consumes` 一律可选依赖：服务缺失时插件自行降级（如无 user 插件时 recorder 回退 `me` 约定），不存在"加载失败级联"
- 服务随提供者停用/热替换自动注销，消费方经 `onAvailable` 感知失效与新版本就绪
- 无版本协商、无服务注册中心持久化——服务名即契约，个人系统的边界

**核心插件全景**（分两梯队）：

第一梯队（入口，基础架构验收后立即实现，顺序即依赖序）：

| 插件 | 形态 | 职责 |
|---|---|---|
| plugin-cli | 冷引导混合 | 用户终端入口 + AdminHostAPI（插件安装与生命周期管理） |
| plugin-http | L2 worker | 纯 API 入口（程序化访问）；L2/supervisor 首个实战 |
| plugin-webui | L2 worker（前后端一体） | 面向用户的主界面 + 分形 UI 插件宿主 |

第二梯队（核心功能与基础能力提供者）：

| 插件 | 形态 | 职责 |
|---|---|---|
| plugin-user | L1 + 服务提供者 | `users` 表（id/name/kind: human\|bot）；提供 `user` 服务（当前用户、查询、列表）；前端访问者身份展示；后续插件经 `services.get('user')` 获得 userId 等基础信息 |
| plugin-core-types | L1（完全体） | 类型体系：大类型 + 小类型层级（parent_key）、lucide 图标（icon）、付款平台等枚举字段——记账表单/统计的完整分类语义 |
| plugin-dataviews | UI 插件（webui 内）+ 内核侧查询 | 数据视图：月度趋势、类型分布、付款平台分布、recorder 维度等多维展示 |
| plugin-snapshot | L1 + 服务提供者 | 快照：按粒度（全库 / 指定账本）备份与回迁（恢复到指定快照） |

## 5. 领域模型

- **值对象**：`Money`（amountMinor: bigint|int + currency，不可变）、`Direction`（income|expense）、`EntryTypeRef`（可空）
- **聚合根 Entry**：不变量在构造时自防护——金额为正、currency 合法、occurred_at 允许未来、type 若存在则必须已注册且 direction 匹配。不合法的 Entry 无法被构造，脏数据无法诞生
- **领域事件**：`EntryRecorded` / `EntryRevised` / `EntryVoided`，进程内同步发布。为 bot 自动化、对账、预扣转正留口
- **仓储**：接口在 domain（EntryRepository），SQLite 实现在 storage-sqlite（依赖倒置），测试用内存实现

## 6. 数据模型（SQLite DDL）

```sql
CREATE TABLE entries (
  id             TEXT PRIMARY KEY,        -- ULID
  book_id        TEXT NOT NULL DEFAULT 'default',   -- 账本预留，第一版不暴露
  direction      TEXT NOT NULL,           -- 'income'|'expense'，统计唯一依据
  amount_minor   INTEGER NOT NULL,        -- 最小货币单位整数（分）
  currency       TEXT NOT NULL,           -- ISO 4217
  occurred_at    INTEGER NOT NULL,        -- 业务时间（epoch ms，允许未来）
  recorded_at    INTEGER NOT NULL,        -- 入库时间
  source         TEXT NOT NULL,           -- 'cli'|'mcp'|'http'|...，dispatcher 注入
  recorder       TEXT NOT NULL,           -- 'me'|'bot:<id>'
  type           TEXT,                    -- 可空：类型插件注册的 key
  extra          TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 1,
  voided_at      INTEGER,                 -- 软删时间，NULL=在册
  void_reason    TEXT
);
CREATE INDEX idx_entries_book_time ON entries(book_id, occurred_at, direction);
CREATE INDEX idx_entries_type      ON entries(type);

CREATE TABLE entry_revisions (            -- 修订前像快照（原行可改 + 留痕）
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL,
  snapshot   TEXT NOT NULL,               -- 修改前完整 JSON
  actor      TEXT NOT NULL,               -- 谁改
  source     TEXT NOT NULL,               -- 从哪改
  revised_at INTEGER NOT NULL,
  reason     TEXT
);

CREATE TABLE type_defs (                  -- 内核零内置，全部来自插件/用户
  key           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  direction     TEXT NOT NULL,            -- 注册时强制声明映射
  parent_key    TEXT,                     -- 类型层级：小类型指向大类型，NULL=大类型
  icon          TEXT,                     -- lucide 图标名（如 'utensils'），前端渲染
  origin        TEXT NOT NULL,            -- 'plugin'|'user'
  owner         TEXT NOT NULL,            -- 插件名 或 'user'
  schema        TEXT,                     -- 附加校验（JSON Schema 片段，可空）
  enabled       INTEGER NOT NULL DEFAULT 1,
  registered_at INTEGER NOT NULL
);

CREATE TABLE field_defs (
  key           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  scope         TEXT NOT NULL,            -- 'expense'|'income'|'both'
  value_type    TEXT NOT NULL,            -- 'string'|'number'|'enum'|'date'|'boolean'
  enum_values   TEXT,                     -- enum 时必填，结构化：[{"value","label","icon"?}]
  origin        TEXT NOT NULL,
  owner         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  registered_at INTEGER NOT NULL
);

CREATE TABLE users (                      -- plugin-user 管理，内核无感知
  id         TEXT PRIMARY KEY,            -- 如 'me'、'u_xxx'、'bot:claude'
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- 'human'|'bot'
  is_default INTEGER NOT NULL DEFAULT 0,  -- 本地单用户的默认身份
  created_at INTEGER NOT NULL
);                                        -- 头像等修饰字段 not now，需要时经迁移加列

CREATE TABLE schema_migrations (          -- 迁移框架自 V1 起步
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

数据纪律：金额恒正整数；软删无物理删除；`occurred_at ≠ recorded_at` 分离；`schema_version` 写入时锁定；extra 未注册键**内核宽松不拒**（数据自包含），入口可选严格（CLI `--strict`）；时间统一 UTC epoch ms 存储、统计按本地时区聚合；数据库文件位置 `~/.ledger/ledger.db`（单文件即备份单元）。

## 7. 调用协议与 dispatcher

- 统一调用格式：`{ command, payload, context }`，`context` 由 dispatcher 组装并自动注入 `source`（适配器身份）与 `recorder`（默认 `me`，可覆盖为 `bot:<id>`）——source/recorder 是调用链元数据，不是用户输入
- 同一协议三种用途：进程内（CLI 冷引导直调）、跨进程（CLI ↔ host socket RPC）、未来任何新入口
- 命令注册表：`entry.add` / `entry.revise` / `entry.void` / `entry.list` / `stats.*` / `type.register` / `field.register` / `plugin.*`（admin）

## 8. 错误模型与校验分层

**类型化错误码**贯穿内核：`TYPE_NOT_REGISTERED` / `TYPE_DIRECTION_MISMATCH` / `ENUM_VIOLATION` / `FIELD_UNKNOWN`（strict 模式）/ `ENTRY_NOT_FOUND` / `PLUGIN_LOAD_FAILED` / …。适配器负责翻译：CLI → 人类可读信息 + 非零退出码；MCP → tool error；HTTP → status code。

**校验三层分工**：

1. 入口层：格式校验，field_defs/type_defs 动态构建 zod schema；CLI flag、MCP tool schema、HTTP body 校验同源生成——注册一个新字段，所有入口自动获得该字段支持，零适配器改动
2. 应用层：编排校验（type 是否注册、direction 是否匹配、book 是否存在）
3. 领域层：不变量（聚合构造即校验，最终防线）

extra 纪律：domain 层永不拒绝未注册键；已注册字段在所有入口按定义校验（类型、枚举）；未注册键在 CLI 默认放行 + 提示，`--strict` 拒绝。

## 9. 事件系统

- 事件：`EntryRecorded` / `EntryRevised` / `EntryVoided`（payload 含完整 Entry 与 context）
- 进程内同步发布；插件订阅随 deactivate 自动退订
- 不做 outbox 持久化（第一版无跨进程消费者；接口稳定，将来需要时加）
- CLI/MCP 冷引导进程中事件仅在本进程生命周期内有效（一次性语义，符合预期）

## 10. 工具链

- TypeScript 5 strict / Node 22 LTS
- pnpm workspace + tsconfig project references
- better-sqlite3（同步 API，WAL 模式——多进程读写安全，CLI 与 host 并发无碍）
- vitest（domain/kernel 内存仓储纯单测；storage 层临时库集成测试）
- tsup 构建各包 ESM 产物；CLI 入口提供 shebang 可执行
- 前端（webui-shell）：Vite + React + Tailwind CSS v4 + shadcn/ui + zustand；UI 插件以 vite lib mode 构建为独立 ESM 产物

## 11. 实施里程碑

| 里程碑 | 内容 | 关键验收 |
|---|---|---|
| M0 | 仓库骨架 + 工具链 | 空包可构建可测试 |
| M1 | domain + storage-sqlite + kernel（注册表/事件/宿主/能力面，暂无热更新）+ plugin-core-types | 零插件自洽测试通过（第一原则的可执行证明），**此后作为永久 CI 门禁**——任何使内核依赖插件的改动立即红；type 插件装/卸后统计均正确；修订/作废/统计全通 |
| M2 | plugin-cli | 双路径自动切换；动态 flag 生成；admin：install/uninstall/字段注册；日常记账可用 |
| M3 | host + L1 热替换回滚 + L2 supervisor + plugin-http | L1 重载失败自动回滚；杀 HTTP worker 宿主存活自动拉起 |
| M4 | plugin-webui（webui-shell + UI 插件宿主 + webui-core-views；http-rpc 此时从 plugin-http 抽出） | 空 shell 零 UI 插件可运行；core-views 装后记账/流水/详情可用；字段注册后表单自动出新控件；UI 插件启停即时生效；webui worker 被杀自动拉起、浏览器重连 |
| M5 | plugin-mcp + 收尾 | MCP 客户端记账查询；错误码全入口贯穿；迁移演练 V1→V2；`ledger backup` |
| M6 | 核心功能插件第二梯队：plugin-user（user 服务）→ plugin-core-types 完全体（类型层级/图标/付款平台）→ plugin-dataviews → plugin-snapshot | user 服务就绪后 webui 显示访问者身份、后续插件可获 userId；类型层级与图标在表单/统计生效；多维数据视图可用；快照按粒度创建与回迁成功 |

## 12. 决策记录（讨论全程已确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 语言/运行时 | TypeScript + Node 22 |
| 2 | 存储 | SQLite + JSON 列（基础字段列化，扩展进 extra） |
| 3 | 内核形态 | core 库 + 双形态组装（host 常驻 / CLI 冷引导），CLI 混合自动模式 |
| 4 | 类型语义 | type 注册制 + 强制 direction 映射；direction 是内核字段，type 可空、纯插件/用户来源 |
| 5 | 审计粒度 | 主表 + entry_revisions 前像快照 |
| 6 | 修订语义 | 原行可改 + 快照留痕（不做会计式冲销） |
| 7 | 删除语义 | 仅软删（void），无物理删除 |
| 8 | 领域事件 | 接口 + 进程内发布，不做 outbox |
| 9 | 架构风格 | DDD（战术模式）× 六边形 × 微内核插件体系 |
| 10 | 插件职权 | 广职权深度信任；仅能力面分级（AdminHostAPI 白名单） |
| 11 | 热更新 | L1 进程内热替换 + 失败回滚；L2 worker 重引导 + supervisor；CLI/MCP 冷引导 |
| 12 | MCP 形态 | 独立进程冷引导（被客户端 spawn），不进 host；L2 验证归 plugin-http |
| 13 | 多账本 | 预留 book_id（默认 'default'），第一版不暴露 |
| 14 | extra 纪律 | 内核宽松 + 入口可选严格（--strict） |
| 15 | source/recorder | dispatcher 自动注入，非用户输入 |
| 16 | 时间 | occurred_at/recorded_at 分离；UTC 存储，本地时区聚合 |
| 17 | 金额 | minor units 正整数 + ISO 4217；多币种只记录不折算 |
| 18 | 演进 | schema_version 从 V1 锁定 + 迁移框架第一版引入 |
| 19 | 包依赖 | plugin-contract 独立成包 = ABI；domain 零 IO；依赖倒置 |
| 20 | recorder 管理 | 自由字符串约定（me / bot:<id>），不做注册表 |
| 21 | WebUI 定位 | 面向用户的必要插件；plugin-webui 为 L2 插件、前后端一体（serve shell 产物 + 调用协议网关 + UI 插件文件服务） |
| 22 | 分形 UI 插件系统 | WebUI 前端 shell 内自成插件宿主，契约镜像内核（webui-contract = 前端 ABI）；shell 零业务视图，核心视图（webui-core-views）亦为 UI 插件 |
| 23 | 前端技术栈 | Vite + React + Tailwind CSS v4 + shadcn/ui + zustand（用户指定） |
| 24 | UI 插件加载/热替换 | 生产态后端 serve ESM + 浏览器动态 import（cache-busting）；开发态 vite dev 本地插件目录；失败保留旧版继续运行 |
| 25 | 协议共享 | 统一调用协议的 HTTP 编码抽为 http-rpc 共享包（plugin-http / plugin-webui 复用，非内核纯工具包） |
| 26 | 插件间服务 | 轻量服务模型：manifest 声明 provides/consumes，拓扑排序加载，consumes 一律可选降级，服务随提供者停用自动注销，无版本协商 |
| 27 | 核心插件定位 | 核心插件 ≠ 仅可行性验证；是必要功能 + 后续插件的基础能力提供者（如 user 插件的 userId） |
| 28 | 类型体系 | 大类型 + 小类型层级（type_defs.parent_key）+ lucide 图标（icon）；付款平台等枚举字段走 field_defs，enum_values 结构化 {value,label,icon?} |
| 29 | 快照粒度 | 全库级（SQLite backup）与账本级（按 book_id 导出）两种粒度；回迁 = 恢复到指定快照 |
| 30 | 马的标尺（整体审阅纪律） | 每项新增过三问：四肢躯干（核心能力/长远奔跑）？肌肉（优雅/健硕）？毛发（not now）？已修剪：users.avatar、ui.settings 空扩展点、http-rpc 预建共享包（推迟到 M4）、core-views 统计图表（归 dataviews） |
