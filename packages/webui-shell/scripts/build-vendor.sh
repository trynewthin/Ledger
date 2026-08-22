#!/usr/bin/env bash
# 前端 vendor：供 shell 与 UI 插件共享的单副本 ESM（经 index.html 的 import map 解析）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/vendor

resolve() { node -p "require.resolve(process.argv[1])" -- "$1"; }

esbuild "$(resolve react)" --bundle --format=esm --outfile=public/vendor/react.js
esbuild "$(node -p "require.resolve('react/package.json')" | xargs dirname)/jsx-runtime.js" \
  --bundle --format=esm --external:react --outfile=public/vendor/react-jsx-runtime.js
esbuild "$(node -p "require.resolve('react-dom/package.json')" | xargs dirname)/client.js" \
  --bundle --format=esm --external:react --outfile=public/vendor/react-dom-client.js
esbuild "$(node -p "require.resolve('react-dom/package.json')" | xargs dirname)/index.js" \
  --bundle --format=esm --external:react --outfile=public/vendor/react-dom.js
esbuild "$(resolve zustand)" --bundle --format=esm --external:react --outfile=public/vendor/zustand.js
esbuild ../webui-contract/dist/index.js --bundle --format=esm --outfile=public/vendor/webui-contract.js

echo "vendor bundles → public/vendor/"
