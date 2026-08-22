# Ledger

个人财务数据操作系统：一套自洽的收支数据内核 + 微内核插件体系。交易类型、动态字段是插件；CLI、WebUI、MCP、HTTP 是插件；WebUI 内部又自成 UI 插件宿主（分形插件架构）。内核只负责让插件活着。

## 文档

- [docs/PRD.md](./docs/PRD.md) — 产品需求：定位、场景、功能范围、里程碑
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 技术架构：包结构、插件契约、数据模型、全部决策记录
- [docs/PROGRESS.md](./docs/PROGRESS.md) — 实施进度与恢复指南：里程碑状态、踩坑记录、待办

## 状态

实施中（2026-08-23）：**M0–M5 已完成并验收提交**（骨架 / 内核 / CLI / 宿主与热更新 / WebUI / MCP），69 个测试全绿。剩 M6（plugin-user → core-types 完全体 → dataviews → snapshot），详见 [PROGRESS.md](./docs/PROGRESS.md)。

## 快速上手

```bash
pnpm install && pnpm build

# CLI 冷引导记账
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js add -d expense -a 12.50

# 常驻宿主 + WebUI（先安装 webui 与 core-types 插件）
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js host
# 另一终端安装插件后访问 http://127.0.0.1:7420
```

## 核心理念

1. **内核自洽** — 零插件时系统完整可用，基础收支数据自洽闭环
2. **数据自包含** — 每条数据冗余携带自身语义，插件可死可换，数据永不失效
3. **插件广职权** — 个人系统，插件与内核深度互信；仅管理能力面走白名单分级
4. **依赖箭头向内** — domain 零 IO，插件只依赖 plugin-contract（系统的 ABI）
