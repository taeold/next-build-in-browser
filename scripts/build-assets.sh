#!/usr/bin/env bash
# Builds everything in site/ that is not checked in: the toolchain node_modules archive, the wasm binding,
# emnapi, wasm-util, semver and the fonts.
#
# Usage: scripts/build-assets.sh [TARBALLS_DIR]
# Without TARBALLS_DIR, downloads the Next.js packages from the release $RELEASE of $REPO and checks them
# against scripts/next-release.sha256. TARBALLS_DIR instead holds your own packed builds of the same three:
#   next-<version>.tgz   next-env-<version>.tgz   next-swc-wasm-wasi-<version>.tgz
set -euo pipefail

REPO=taeold/next.js
RELEASE=browser-20261118
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SITE=$ROOT/site
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [ $# -gt 0 ]; then
  TARBALLS=$(cd "$1" && pwd)
else
  TARBALLS=$WORK/release
  echo "== $REPO release $RELEASE"
  mkdir -p "$TARBALLS"
  while read -r _ name; do
    curl -fsSL -o "$TARBALLS/$name" "https://github.com/$REPO/releases/download/$RELEASE/$name"
  done < "$ROOT/scripts/next-release.sha256"
  (cd "$TARBALLS" && sha256sum --quiet -c "$ROOT/scripts/next-release.sha256")
fi
one() { ls "$TARBALLS"/$1 | head -1; }

echo "== toolchain node_modules (next, react, react-dom) from $TARBALLS"
mkdir -p "$WORK/app"
cat > "$WORK/app/package.json" <<EOF
{
  "private": true,
  "dependencies": {
    "next": "file:$(one 'next-[0-9]*.tgz')",
    "@next/swc-wasm-wasi": "file:$(one 'next-swc-wasm-wasi-*.tgz')",
    "react": "19.3.1",
    "react-dom": "19.3.1"
  },
  "overrides": { "@next/env": "file:$(one 'next-env-*.tgz')" }
}
EOF
(cd "$WORK/app" && npm install --no-audit --no-fund --omit=optional --loglevel=error)

echo "== wasm binding and emnapi"
WASI=$WORK/app/node_modules/@next/swc-wasm-wasi
mkdir -p "$SITE/assets" "$SITE/pkg"
rm -f "$SITE"/assets/*.gz
node "$ROOT/scripts/compress.mjs" "$WASI/next-swc.wasm32-wasi.wasm" "$SITE/assets/next-swc.wasm.br"
cp "$WASI"/emnapi-core.mjs "$WASI"/emnapi-runtime.mjs "$WASI"/LICENSE.emnapi "$SITE/pkg/"
rm -rf "$WASI" "$WORK/app/node_modules/.package-lock.json"

echo "== Node.js polyfills"
mkdir -p "$WORK/polyfills" "$WORK/extra"
(cd "$WORK/polyfills" && echo '{"private":true}' > package.json && npm install --no-audit --no-fund --loglevel=error \
  path-browserify events buffer util stream-browserify readable-stream@3 string_decoder url querystring-es3 \
  assert browserify-zlib os-browserify create-hash create-hmac randombytes punycode)
echo "module.exports = {};" > "$WORK/extra/empty.js"

echo "== trim"
# Source maps (half the bytes) and docs are never read by a build or by the deployed server. License files stay.
for d in "$WORK/app/node_modules" "$WORK/polyfills/node_modules"; do
  find "$d" -type f \( -name '*.map' -o \( -iname '*.md' ! -iname '*licen[cs]e*' \) \) -delete
done

echo "== archive"
node "$ROOT/scripts/pack.mjs" "$SITE/assets/base.pack.br" \
  "$WORK/app/node_modules=/app/node_modules" "$WORK/polyfills/node_modules=/polyfills/node_modules" "$WORK/extra=/polyfills"

echo "== wasm-util, semver, brotli decoder, fonts"
mkdir -p "$WORK/tools" "$SITE/assets/fonts"
(cd "$WORK/tools" && echo '{"private":true}' > package.json && npm install --no-audit --no-fund --loglevel=error @tybys/wasm-util@0.10 semver@7 esbuild geist@1 brotli-dec-wasm@2)
# The published ESM build hard-codes NODE_DEBUG_NATIVE="wasi", which logs every WASI call.
sed 's/return "wasi";/return undefined;/' "$WORK/tools/node_modules/@tybys/wasm-util/dist/wasm-util.esm.js" > "$SITE/wasm-util.js"
grep -q 'return undefined;' "$SITE/wasm-util.js"
echo 'import semver from "semver"; export default semver;' > "$WORK/tools/semver-entry.mjs"
(cd "$WORK/tools" && npx esbuild semver-entry.mjs --bundle --format=esm --minify --log-level=warning --outfile="$SITE/assets/semver.mjs")
B=$WORK/tools/node_modules/brotli-dec-wasm
cp "$B"/pkg/brotli_dec_wasm.js "$B"/pkg/brotli_dec_wasm_bg.wasm "$SITE/pkg/"
cp "$B"/LICENSE-MIT.txt "$SITE/pkg/LICENSE.brotli-dec-wasm"
G=$WORK/tools/node_modules/geist/dist/fonts
cp "$G"/geist-sans/Geist-Regular.woff2 "$G"/geist-sans/Geist-SemiBold.woff2 "$G"/geist-mono/GeistMono-Regular.woff2 "$G"/geist-mono/GeistMono-Bold.woff2 "$SITE/assets/fonts/"
cp "$WORK/tools/node_modules/geist/LICENSE.txt" "$SITE/assets/fonts/LICENSE.txt"

echo "done: $(du -sh "$SITE/assets" | cut -f1) in site/assets"
