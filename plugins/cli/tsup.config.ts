import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  dts: { entry: ['src/index.ts'] },
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  target: 'node22',
})
