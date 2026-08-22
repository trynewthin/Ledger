import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // workspace 链接包以原生 ESM 加载（dist）：
    // vite-node 的 import 拦截会破坏文件 URL 的 ?t= cache-busting（L1 热替换依赖它）
    server: {
      deps: {
        external: [/^@ledger\//],
      },
    },
  },
})
