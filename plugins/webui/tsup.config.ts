import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
  // 安装态独立于仓库 node_modules：打包依赖（kernel/http-rpc 的 UI 插件目录助手）
  noExternal: [/./],
})
