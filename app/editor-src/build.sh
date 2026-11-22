#!/bin/sh
# Rebuilds app/public/vendor/ (editor bundle + KaTeX assets). Needs npm.
# Dependencies are installed in a temp folder so node_modules stays out of Google Drive.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$SRC/../public/vendor"
TMP="${TMPDIR:-/tmp}/paper-editor-build"
mkdir -p "$TMP" "$OUT/katex"
cp "$SRC/package.json" "$SRC/editor.js" "$TMP/"
cd "$TMP"
npm install --silent --no-audit --no-fund
npx esbuild editor.js --bundle --minify --format=iife --target=es2020 --outfile="$OUT/editor.bundle.js"
cp node_modules/katex/dist/katex.min.css "$OUT/katex/"
rm -rf "$OUT/katex/fonts" && cp -R node_modules/katex/dist/fonts "$OUT/katex/"
echo "Built $OUT/editor.bundle.js"
