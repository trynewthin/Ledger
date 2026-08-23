# Ledger 插件开发驾驭工程指南

> 本文覆盖后端 L1/L2 插件、冷引导入口和浏览器 UI 插件。插件的运行时权威契约分别位于 `packages/plugin-contract` 与 `packages/webui-contract`。

## 1. 先选择插件形态

| 形态 | 选择条件 | 可用能力 | 主要限制 |
|---|---|---|---|
| L1 `inprocess` | 纯逻辑、类型/字段、事件、插件间服务 | 完整 HostAPI、进程内 services | 必须无进程内持久状态，热替换产物必须单文件 |
| L2 `worker` | HTTP、Web server、独立 IO、需要故障隔离 | registry、ledger、dispatch、events、log 的 worker 代理 | services 不跨 worker；重载等于重启 |
| 冷引导入口 | CLI、MCP、由外部程序管理生命周期 | 自行装配同一 kernel，可按白名单获得 admin | 进程退出即丢失内存状态 |
| UI 插件 | 页面、widget、详情面板 | UiHostAPI、统一 HTTP client、只读 store | 浏览器环境；不得依赖 Node API |

如果能力是所有账目都必须遵守的永久不变量，它不是插件，应进入 domain/kernel。插件必须允许被卸载，而不破坏已有 Entry 的可读性和统计语义。

## 2. 后端插件契约

后端插件实现 `LedgerPlugin`：

```ts
import { definePlugin } from '@ledger/plugin-contract'

export default definePlugin({
  manifest: {
    name: 'plugin-example',
    version: '0.1.0',
    isolation: 'inprocess',
  },

  async activate(host) {
    host.log.info('plugin-example activated')
  },

  async deactivate({ reason }) {
    // 只清理插件自己创建、且不会由宿主管理的运行时资源
  },
})
```

模块应默认导出插件，或导出名为 `plugin` 的对象。loader 也能识别唯一的插件形状导出，但不应依赖该兜底规则。

### 2.1 HostAPI

- `registry`：注册和读取类型、字段。
- `events`：订阅领域事件；订阅随 deactivate 自动清理。
- `ledger`：直接调用共享账务用例。
- `services`：提供或消费进程内服务。
- `dispatch`：转发统一命令，入口插件应优先使用它。
- `log`：记录带插件上下文的日志。
- `meta`：插件名和运行数据目录。

只有白名单中的核心维护插件会获得 `AdminHostAPI.plugins` 和 `AdminHostAPI.host`。仅在 manifest 声明 `capabilities: ['admin']` 不会自动获得权限。

## 3. 标准目录

一个后端插件的最小结构：

```text
plugins/example/
  src/index.ts
  src/example.test.ts
  package.json
  plugin.json
  tsconfig.json
  tsup.config.ts
```

`plugin.json` 是安装目录和入口清单：

```json
{
  "name": "plugin-example",
  "main": "./dist/index.js",
  "isolation": "inprocess"
}
```

模块代码中的 `manifest` 是运行时权威，必须包含 name、version 和 isolation。两处 name/isolation 应保持一致。

`package.json` 至少提供 build、test 和 typecheck，并只把 `@ledger/plugin-contract` 作为正式工作区依赖。测试所需的 kernel/domain 可以放入 devDependencies。

## 4. 构建后端插件

安装后的插件目录独立于本仓库 `node_modules`，产物必须自包含：

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
  noExternal: [/./],
})
```

L1 热替换通过复制入口为唯一文件名后重新 import，因此 L1 插件必须打成单文件，不能依赖相对 chunk。不要把 `better-sqlite3` 等原生依赖留在安装态 import 中；应消费宿主提供的结构化 `db` 服务。

构建完成后确认以下文件存在：

```text
plugin.json
dist/index.js
```

如果插件需要静态资源，放在 `assets/`、`shell/` 或构建产物目录中；安装器只复制允许的插件文件。

## 5. 注册类型和动态字段

静态贡献可写在运行时 manifest：

```ts
export default definePlugin({
  manifest: {
    name: 'plugin-example-types',
    version: '0.1.0',
    isolation: 'inprocess',
    contributes: {
      types: [
        { key: 'travel', label: '旅行', direction: 'expense', icon: 'Plane' },
        { key: 'travel-hotel', label: '住宿', direction: 'expense', parentKey: 'travel' },
      ],
      fields: [
        {
          key: 'booking_platform',
          label: '预订平台',
          scope: 'expense',
          valueType: 'enum',
          enumValues: [
            { value: 'direct', label: '直接预订' },
            { value: 'ota', label: '第三方平台' },
          ],
        },
      ],
    },
  },
  async activate() {},
  async deactivate() {},
})
```

需要运行时计算时，可在 `activate()` 调用 `host.registry.registerType()` 或 `registerField()`。

约束：

1. key 是长期数据标识，不随显示文案变化。
2. type 必须声明 direction；子类型的方向应与父类型一致。
3. enum 字段必须声明 enumValues。
4. 字段值保存在 `Entry.extra`，注册定义不是历史值的唯一解释来源。
5. 卸载插件后定义可标为 unavailable，但已有数据必须继续可用。

注册一次后，CLI 动态 flag、MCP schema 和 Web UI 表单会共同消费注册表；不要分别修改三个入口维护重复定义。

## 6. 提供和消费服务

服务适用于多个 L1 插件共享的稳定能力。先在 `plugin-contract` 固化消费方真正需要的结构子集：

```ts
export interface ExampleService {
  lookup(id: string): ExampleRecord | undefined
}
```

provider：

```ts
const service: ExampleService = { lookup: (id) => /* ... */ undefined }
host.services.provide<ExampleService>('example', service)
```

consumer：

```ts
const service = host.services.get<ExampleService>('example')
if (!service) {
  host.log.warn('example service unavailable; feature disabled')
  return
}
```

manifest 中通过 `provides` 和 `consumes` 声明服务名，用于拓扑加载和运行信息。`consumes` 是可选依赖：缺失时插件必须自行降级，不能导致其他插件级联失败。

services 没有版本协商，服务名即契约。破坏性变化必须改变服务名或升级 contract major。L2 worker 当前不能提供或消费进程内服务。

## 7. 使用数据库服务

需要插件自有表的 L1 插件按以下方式工作：

1. 从 `host.services.get<SqliteDb>('db')` 获取连接。
2. 缺失时明确降级或激活失败，不自行解析仓库内数据库模块。
3. 用 `CREATE TABLE IF NOT EXISTS` 初始化插件自有表。
4. 把消费的最小 SQL 接口保持在 plugin-contract。
5. 对 schema 演进建立插件自己的迁移纪律。

只有 Entry、revision、type_defs 和 field_defs 等内核数据应由 storage-sqlite 管理。插件表不能反向成为内核统计成立的前提。

## 8. 订阅事件

当前领域事件包括 `EntryRecorded`、`EntryRevised` 和 `EntryVoided`。

```ts
host.events.subscribe('EntryRecorded', (payload) => {
  // handler 错误会被记录，不会阻断其他订阅者
})
```

订阅由宿主按 owner 托管，插件停用时自动移除。事件 handler 应快速、幂等；长耗时或有故障风险的任务应转交隔离进程，不要阻塞进程内同步发布链。

## 9. 开发 L2 worker 插件

L2 插件仍实现相同 `LedgerPlugin`，但 manifest 使用 `isolation: 'worker'`。适合监听端口或管理外部连接。

生命周期要求：

1. 在 `activate()` 完成 server 启动，并让启动错误向外抛出。
2. 只监听明确的本地地址，端口允许通过环境变量覆盖。
3. 在 `deactivate()` 停止接收连接并关闭全部资源。
4. 不依赖模块级状态跨 reload 保留。
5. 通过 `host.dispatch()` 转发业务请求。

worker 内的 HostAPI 是 postMessage 代理。不要假设对象引用、数据库连接或 service 实例可以跨线程传递。worker 崩溃由 supervisor 退避重启，插件应能重复 activate。

## 10. 开发冷引导入口

冷引导入口适合被终端或客户端直接启动的协议。它应复用既有装配流程，不创建另一套业务服务。

关键纪律：

- 组装 SQLite repository、metadata store 和 kernel。
- 提供入口拥有的 `db` 服务。
- 加载已安装的 L1 插件；无法承载的 worker 插件明确跳过。
- 为每次调用注入入口 source 和 recorder。
- 退出时依次 shutdown kernel 并关闭数据库。
- 入口构建使用 `splitting: false`，shebang 只保留一处。

CLI 的混合会话和 MCP 的 stdio 进程是参考实现。

## 11. 开发 UI 插件

UI 插件最小结构：

```text
plugins/example-ui/
  src/index.tsx
  package.json
  ui-plugin.json
  tsconfig.json
  vite.config.ts
```

`ui-plugin.json`：

```json
{
  "name": "example-ui",
  "version": "0.1.0",
  "entry": "./index.js"
}
```

入口示例：

```tsx
import { defineUiPlugin } from '@ledger/webui-contract'

export default defineUiPlugin({
  manifest: { name: 'example-ui', version: '0.1.0' },
  async activate(host) {
    host.registry.registerPage(
      'example',
      () => <main>Example</main>,
      { label: '示例', order: 50 },
    )
  },
  async deactivate() {},
})
```

可用扩展点：

- `registerPage(key, component, options)`：页面和导航。
- `registerWidget(key, component, options)`：Dashboard widget。
- `registerPanel(key, component, options)`：详情附加面板。

数据访问统一使用 `host.client.call(command, payload)`。注册项由 shell 按 owner 托管，停用时自动清理。

## 12. 构建 UI 插件

UI 插件使用 Vite library mode 输出独立 ESM：

```ts
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', '@ledger/webui-contract'],
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
})
```

build script 必须把 `ui-plugin.json` 复制到 `dist/`。React、JSX runtime 和 webui-contract 必须 externalize，由 shell 的 import map 提供共享单例。

## 13. 安装与调试

先构建插件，再从源码目录安装后端插件：

```bash
pnpm --filter @ledger/plugin-example build
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js plugin install plugins/example
```

安装 UI 插件时传构建目录：

```bash
pnpm --filter @ledger/plugin-example-ui build
LEDGER_HOME=/tmp/ledger node plugins/cli/dist/cli.js ui install plugins/example-ui/dist
```

常驻 host 运行时可使用 `plugin load/reload/unload`。L1 reload 会在新版本激活失败时尝试恢复旧实例；L2 reload 会重启 worker。

调试时建议使用独立临时 `LEDGER_HOME`，避免污染真实账本。不要把 `/tmp/ledger` 示例替换为未经确认的生产目录执行 restore 或 uninstall。

## 14. 测试要求

后端插件至少证明：

1. manifest、贡献物或服务注册正确。
2. activate 可重复执行或在重引导后得到一致状态。
3. deactivate 后托管项被清理。
4. 缺少可选 service 时明确降级。
5. 插件卸载后历史 Entry 仍可读取和统计。
6. 构建产物能从独立插件目录加载。

L2 插件还要证明 server 可调用、端口可配置、worker 被杀后自动恢复。UI 插件要证明 manifest 和 ESM 产物正确、外部依赖未被重复打包、注册项能正常显示和清理。

完成前执行：

```bash
pnpm --filter <package-name> build
pnpm --filter <package-name> test
pnpm --filter <package-name> typecheck
pnpm -r --no-bail test
pnpm typecheck
```

## 15. 兼容性与安全边界

- `plugin-contract` 和 `webui-contract` 是 ABI；破坏性变更必须升 major。
- DTO 字段和服务方法尽量只做向后兼容扩展。
- 插件运行在深度信任模型下，不安装不可信代码。
- 管理能力按 host 白名单授权，manifest 只是声明意图。
- 插件文件服务必须防目录穿越，并限制到对应插件目录。
- 插件日志不得包含账本密钥、环境机密或不必要的完整财务数据。

## 16. 发布检查清单

1. 选择的隔离形态与 IO/故障风险匹配。
2. 插件名、版本和 isolation 在文件清单与运行时 manifest 中一致。
3. 正式依赖只面向稳定 contract。
4. 后端产物自包含；L1 是单文件。
5. UI 产物 externalize 共享依赖并包含 `ui-plugin.json`。
6. key、服务名和命令名稳定且无冲突。
7. 可选依赖缺失时可降级。
8. activate/deactivate/reload 有测试。
9. 卸载不破坏历史数据。
10. 包级和全量验证全部通过。

现有参考实现：

- 类型/字段插件：`plugins/core-types`
- 数据库服务插件：`plugins/user`、`plugins/snapshot`
- L2 入口插件：`plugins/http`、`plugins/webui`
- 冷引导入口：`plugins/cli`、`plugins/mcp`
- UI 页面插件：`plugins/webui-core-views`
- UI widget 插件：`plugins/dataviews`
