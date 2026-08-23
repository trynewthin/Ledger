# Ledger

个人财务数据操作系统：一套自洽的收支数据内核 + 微内核插件体系。交易类型、动态字段是插件；CLI、WebUI、MCP、HTTP 是插件；WebUI 内部又自成 UI 插件宿主（分形插件架构）。内核只负责让插件活着。

## 文档

- [docs/PROJECT_OVERVIEW.md](./docs/PROJECT_OVERVIEW.md) — 项目概要：定位、核心模型、架构、运行方式与当前边界
- [docs/FEATURE_DEVELOPMENT_GUIDE.md](./docs/FEATURE_DEVELOPMENT_GUIDE.md) — 功能开发驾驭工程指南：改动落点、跨层链路与验收门禁
- [docs/PLUGIN_DEVELOPMENT_GUIDE.md](./docs/PLUGIN_DEVELOPMENT_GUIDE.md) — 插件开发驾驭工程指南：L1/L2、冷引导与 UI 插件开发
- [docs/EVOLUTION_GOALS.md](./docs/EVOLUTION_GOALS.md) — 演进目标：插件能力、配置存储、兼容性与生态路线
- [docs/archive/README.md](./docs/archive/README.md) — 已归档的原始 PRD、架构决策与 M0–M6 实施记录

## 状态

**当前状态（2026-08-23）**：M0–M6 产品范围已完成；现已增加 Config Core 与 Storage Core，统一提供仓库根配置、热加载、插件声明式读取、轻量命名空间存储和整体导入导出。当前系统说明见 [项目概要](./docs/PROJECT_OVERVIEW.md)，历史里程碑见 [归档进度](./docs/archive/PROGRESS.md)。

## 快速上手

```bash
pnpm install && pnpm build
node plugins/cli/dist/cli.js init

# CLI 冷引导记账（storage.dataDir 来自仓库根 ledger.config.json）
node plugins/cli/dist/cli.js add -d expense -a 12.50
node plugins/cli/dist/cli.js plugin install plugins/core-types
node plugins/cli/dist/cli.js add -d expense -a 12.50 -t food-coffee --payment-platform alipay

# 身份与快照（plugin-user / plugin-snapshot）
node plugins/cli/dist/cli.js plugin install plugins/user
node plugins/cli/dist/cli.js user get
node plugins/cli/dist/cli.js plugin install plugins/snapshot
node plugins/cli/dist/cli.js snapshot create

# 常驻宿主 + WebUI（安装 webui、core-views、dataviews 后访问 http://127.0.0.1:7420）
node plugins/cli/dist/cli.js host
# 另一终端：
node plugins/cli/dist/cli.js plugin install plugins/webui
node plugins/cli/dist/cli.js ui install plugins/webui-core-views/dist
node plugins/cli/dist/cli.js ui install plugins/dataviews/dist
```

`ledger init`（或 `ledger config init`）在当前项目根目录创建 `ledger.config.json`，初始化默认 `.ledger/` 存储目录，并写入 `.gitignore`。两者均不参与提交；`LEDGER_HOME` 仍可作为测试或一次性运行覆盖。

HTTP 插件同时提供领域化 REST 与兼容 RPC：`POST /entries`、`GET /entries`、`PATCH /entries/:id`、`GET /stats/summary`，以及 `POST /rpc`。`GET /capabilities` 可发现全部应用命令及其 CLI/HTTP/MCP 绑定。

Storage Core 的完整快照不依赖插件：`ledger storage snapshot create/list/delete/switch`。`plugin-snapshot` 在此基础上提供账本级快照等扩展能力。

## 核心理念

1. **内核自洽** — 零插件时系统完整可用，基础收支数据自洽闭环
2. **数据自包含** — 每条数据冗余携带自身语义，插件可死可换，数据永不失效
3. **插件广职权** — 个人系统，插件与内核深度互信；仅管理能力面走白名单分级
4. **依赖箭头向内** — domain 零 IO，插件只依赖 plugin-contract（系统的 ABI）
