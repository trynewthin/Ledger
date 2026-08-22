import { defineConfig } from 'vite'

// UI 插件：vite lib mode 构建为独立 ESM；
// react/webui-contract 外置，经 shell 的 import map 在浏览器解析（共享单副本 react）
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', '@ledger/webui-contract'],
      output: { entryFileNames: 'index.js', chunkFileNames: '[name].js', assetFileNames: '[name][extname]' },
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
  },
})
