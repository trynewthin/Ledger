import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node22',
  // 安装态插件目录独立于本仓库 node_modules：打包依赖使 dist 自包含。
  noExternal: [/./],
})
