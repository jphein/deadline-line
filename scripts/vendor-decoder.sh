#!/usr/bin/env bash
# Re-vendor the Deadline Decoder rules engine from a local checkout of jphein/deadline-decoder-mcp: its
# src/{server,mcp,decoder}.js, src/rules/{dates,rules}.js and LICENSE go to vendor/deadline-decoder-mcp/, each file
# headed with the upstream branch, commit and license. Upstream edits belong upstream: change them there, then
# run this again, rather than patching the copy here.
# Usage: scripts/vendor-decoder.sh <path to a deadline-decoder-mcp checkout>
set -euo pipefail
src=$(cd "${1:?usage: scripts/vendor-decoder.sh <path to a deadline-decoder-mcp checkout>}" && pwd)
dest="$(cd "$(dirname "$0")/.." && pwd)/vendor/deadline-decoder-mcp"
[ -z "$(git -C "$src" status --porcelain -- src LICENSE package.json)" ] || { echo "upstream has uncommitted changes in src/, LICENSE or package.json; commit them first" >&2; exit 1; }
# The full commit in each header, so a test can check it against UPSTREAM.sha256 exactly (a short sha hides
# tampering in its unseen digits).
sha=$(git -C "$src" rev-parse HEAD) branch=$(git -C "$src" rev-parse --abbrev-ref HEAD)
license=$(node -p "require(process.argv[1]).license" "$src/package.json")
for f in src/server.js src/mcp.js src/decoder.js src/rules/dates.js src/rules/rules.js; do
  mkdir -p "$dest/$(dirname "$f")"
  {
    if head -1 "$src/$f" | grep -q '^#!'; then head -1 "$src/$f"; fi
    echo "// Vendored from jphein/deadline-decoder-mcp ($branch @ $sha), licensed $license: see vendor/deadline-decoder-mcp/LICENSE."
    echo "// Upstream edits belong upstream: change them there and re-vendor with scripts/vendor-decoder.sh, rather than patch here."
    grep -v '^#!' "$src/$f"
  } > "$dest/$f"
done
cp "$src/LICENSE" "$dest/LICENSE"
# The upstream files' own hashes, so a test can check the vendored copies still match them byte for byte
# (tests/vendor.test.mjs strips the two header lines and re-hashes).
{
  echo "# jphein/deadline-decoder-mcp $branch @ $(git -C "$src" rev-parse HEAD)"
  (cd "$src" && sha256sum src/server.js src/mcp.js src/decoder.js src/rules/dates.js src/rules/rules.js LICENSE)
} > "$dest/UPSTREAM.sha256"
echo "vendored jphein/deadline-decoder-mcp $branch @ $sha ($license) into vendor/deadline-decoder-mcp/"
