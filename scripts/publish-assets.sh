#!/usr/bin/env bash
# Publishes site/assets/*.br to the repo's `assets` branch, which jsDelivr serves, and pins site/app.js to the new
# commit. Run after `npm run assets`, then commit and deploy as usual.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git -C "$ROOT" fetch -q origin assets
git -C "$ROOT" worktree add -q "$WORK/assets" origin/assets
cp "$ROOT"/site/assets/*.br "$WORK/assets/"
git -C "$WORK/assets" add -A
if git -C "$WORK/assets" diff --cached --quiet; then
  echo "assets unchanged"
else
  git -C "$WORK/assets" commit -q -m "Toolchain assets"
  git -C "$WORK/assets" push -q origin HEAD:assets
fi
SHA=$(git -C "$WORK/assets" rev-parse HEAD)
git -C "$ROOT" worktree remove --force "$WORK/assets"
sed -i "s|cdn.jsdelivr.net/gh/taeold/next-build-in-browser@[0-9a-f]*|cdn.jsdelivr.net/gh/taeold/next-build-in-browser@$SHA|" "$ROOT/site/app.js"
echo "site/app.js now loads assets from commit $SHA"
