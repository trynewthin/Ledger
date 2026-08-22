import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', main: 'src/main.ts' },
  format: ['esm'],
  dts: { entry: ['src/index.ts'] },
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  target: 'node22',
  splitting: false,
})
