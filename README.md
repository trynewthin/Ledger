# Ledger

个人财务系统。Go 提供网页、API 和鉴权 HTTP MCP；React / Vite 前端基于 shadcn `beqC918K` 预设，SQLite 保存数据。

## 功能

1. 快速记账：金额、类别必填，日期默认中国时区今天；商家、备注、收入与外币按需填写。
2. 日、周、月统计：期间收支、分类分布、每日趋势、上一期比较，以及带筛选和分页的明细。
3. 两级分类：新增、改名、归档；已有账目保留分类关联。
4. 账目追溯：编辑保留前后内容和来源，废止必填原因，可恢复，无永久删除入口。
5. 独立资产概况：手工维护资产、负债与余额快照，不与日常记账自动联动。
6. 单用户账号：密码哈希、多设备 90 天登录、会话撤销；修改密码后全部网页会话失效。
7. MCP：前端签发、命名、撤销 Token，支持完整账目、分类和资产操作，批量添加原子执行并持久化去重。

## 本地运行

需要 Go 1.26.5+、Node.js 22.12+。

```sh
npm ci --prefix web
npm run build --prefix web
export LEDGER_ADMIN_USER=owner
read -rs LEDGER_ADMIN_PASSWORD
export LEDGER_ADMIN_PASSWORD
export LEDGER_ORIGIN=http://localhost:8080
go run ./cmd/ledger
```

输入至少 12 字节、最多 72 字节的初始密码。打开 `http://localhost:8080`。仅空数据库会创建初始账号，之后修改启动密码不会重置现有账号。SQLite 默认保存在 `data/ledger.db`。

前端热更新时，将 `LEDGER_ORIGIN` 改为 `http://localhost:5173`，重启 Go，在另一个终端执行 `npm run dev --prefix web`。Vite 将 `/api` 与 `/mcp` 代理给 Go。

变量示例见 [.env.example](.env.example)。Go 不自动加载 `.env`；通过进程环境传入。生产启动使用 `LEDGER_ADMIN_PASSWORD_FILE` 读取 Docker secret。

## 检查

```sh
go test -race ./internal/... ./cmd/...
go vet ./internal/... ./cmd/...
npm run lint --prefix web
npm run build --prefix web
cd web
npx playwright install chromium
npm run test:e2e
```

浏览器测试使用独立的 `web/.e2e/` 数据库。覆盖记账、编辑、废止恢复、资产快照、分类、Token 与多设备撤销，并生成桌面与手机截图。

## 数据规则

1. 金额以十进制字符串传输，以整数分计算统计，禁止浮点金额输入、负数、科学计数法和超出两位的小数。单笔上限为 12 位整数。日元只接受整数。
2. 支持 CNY、USD、EUR、HKD、GBP、JPY、AUD、CAD、SGD、CHF。人民币金额直接计入统计；外币需提供 `cny_amount`，未折算金额按币种单独返回，不自动抓取汇率。
3. 日期采用 `YYYY-MM-DD`，默认时区为 Asia/Shanghai，周一是一周开始。上一期比较采用完整上一日／周／月，当前期可能尚未结束。
4. 修改账目、废止、恢复和修改资产都需要查询取得当前 `version`；过期版本返回冲突，调用方应刷新后重新判断。
5. 批量请求最多 200 笔。`request_id` 在全账本唯一，同一键和内容返回原结果；同键不同内容拒绝。去重记录在数据库重启后仍然有效。
6. 资产保存的是最新余额及每次变更快照，不从消费中扣减余额。归档项目退出当前资产汇总；余额日期不能早于该项目当前快照日期。

## MCP

地址：`https://你的域名/mcp`。传输方式为 Streamable HTTP，使用官方 Go MCP SDK，支持 SDK 所实现的协议版本协商。连接平台须支持自定义 Bearer 请求头；此服务不提供 OAuth 登录流程或旧版独立 `/sse` 端点。

```json
{
  "mcpServers": {
    "ledger": {
      "url": "https://你的域名/mcp",
      "headers": {
        "Authorization": "Bearer <前端创建的 Token>"
      }
    }
  }
}
```

不同平台配置格式可能不同，核心是服务地址与 `Authorization` 请求头。Token 完整值仅在签发时显示，数据库只保存摘要。Token 到期或撤销后立即不能使用；网页登录 Cookie 不能作为 MCP Token。

| 工具 | 用途 |
| --- | --- |
| `categories_list` / `categories_save` | 查询、新增、修改、归档与恢复分类 |
| `entries_list` | 日期、分类、关键词、状态筛选与分页 |
| `entries_add` / `entries_batch_add` | 单笔或批量添加，必须携带 `request_id` |
| `entries_update` | 编辑完整账目并保留历史 |
| `entries_void` / `entries_restore` | 按原因废止与恢复 |
| `history_list` | 账目、分类或资产的变更历史 |
| `report` | 有效收支汇总；金额单位为分 |
| `assets_list` / `assets_save` | 查询与更新资产、负债快照 |
| `assets_timeline` | 根据余额快照重建净资产变化 |

AI 导入账单时，先查询分类，再分批添加。为每批保留唯一请求标识，网络重试时使用完全相同的参数；如果换用新标识，系统会按新请求记账，不根据相同金额和日期擅自去重。

示例工具参数：

```json
{
  "request_id": "statement-202609-batch-001",
  "entries": [
    {
      "amount": "35.50",
      "category_id": "从 categories_list 取得的 ID",
      "date": "2026-09-05",
      "merchant": "午餐",
      "kind": "expense"
    }
  ]
}
```

## Docker 与发布

部署步骤、备份和恢复见 [deploy/README.md](deploy/README.md)。GitHub Actions 在提交到 `main` 后测试并构建 `ghcr.io/trynewthin/ledger` 镜像；生产更新使用独立的手动工作流，或通过服务器的 `update.sh` 拉取指定镜像摘要。

本项目使用单实例 SQLite；部署保持单副本，数据库在独立 Docker 卷中。不要用容器临时文件系统保存账本，不要删除带有账本数据的 Docker 卷。
