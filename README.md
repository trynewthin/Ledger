# Ledger

个人财务数据操作系统：一套自洽的收支数据内核 + 微内核插件体系。交易类型、动态字段是插件；CLI、WebUI、MCP、HTTP 是插件；WebUI 内部又自成 UI 插件宿主（分形插件架构）。内核只负责让插件活着。

## 文档

- [docs/PROJECT_OVERVIEW.md](./docs/PROJECT_OVERVIEW.md) — 项目概要：定位、核心模型、架构、运行方式与当前边界
- [docs/FEATURE_DEVELOPMENT_GUIDE.md](./docs/FEATURE_DEVELOPMENT_GUIDE.md) — 功能开发驾驭工程指南：改动落点、跨层链路与验收门禁
- [docs/PLUGIN_DEVELOPMENT_GUIDE.md](./docs/PLUGIN_DEVELOPMENT_GUIDE.md) — 插件开发驾驭工程指南：L1/L2、冷引导与 UI 插件开发
- [docs/archive/README.md](./docs/archive/README.md) — 已归档的原始 PRD、架构决策与 M0–M6 实施记录

## 状态

**实施完成（2026-08-23）**：M0–M6 全部里程碑完成并验收提交，84 个测试全绿、typecheck 全绿。M6 交付 plugin-user（身份目录 + 'db'/'user' 服务契约）、core-types 完全体（类型层级 + 图标 + 付款平台字段）、plugin-dataviews（概览页数据视图 UI 插件 + stats.byRecorder）、plugin-snapshot（全库/账本级快照与回迁）。当前系统说明见 [项目概要](./docs/PROJECT_OVERVIEW.md)，历史里程碑见 [归档进度](./docs/archive/PROGRESS.md)。

## 快速上手

```bash
pnpm install && pnpm build

# CLI 冷引导记账（类型/字段/身份/快照均为插件，按需安装）
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js add -d expense -a 12.50
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js plugin install plugins/core-types
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js add -d expense -a 12.50 -t food-coffee --payment-platform alipay

# 身份与快照（plugin-user / plugin-snapshot）
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js plugin install plugins/user
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js user get
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js plugin install plugins/snapshot
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js snapshot create

# 常驻宿主 + WebUI（安装 webui、core-views、dataviews 后访问 http://127.0.0.1:7420）
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js host
# 另一终端：
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js plugin install plugins/webui
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js ui install plugins/webui-core-views/dist
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js ui install plugins/dataviews/dist
```

## 核心理念

1. **内核自洽** — 零插件时系统完整可用，基础收支数据自洽闭环
2. **数据自包含** — 每条数据冗余携带自身语义，插件可死可换，数据永不失效
3. **插件广职权** — 个人系统，插件与内核深度互信；仅管理能力面走白名单分级
4. **依赖箭头向内** — domain 零 IO，插件只依赖 plugin-contract（系统的 ABI）
