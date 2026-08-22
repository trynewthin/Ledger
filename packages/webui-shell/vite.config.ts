import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    rollupOptions: {
      input: 'index.html',
      // react/zustand 走 import map（与 UI 插件共享单副本）
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'zustand'],
    },
  },
})
