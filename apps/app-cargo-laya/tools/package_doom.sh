#!/bin/sh
# Packages the Doom engine for the CDN (demos/doom.html loads it from there):
#   out/doom/chocolate-doom.{js,wasm,data}      the prebuilt engine (+ Freedoom 2 in .data)
#   out/doom/LICENSES/                           GPL-2.0 (Chocolate Doom), Freedoom (BSD), SDL2, Emscripten
#   out/doom/chocolate-doom-source-<commit>.tar.gz   the corresponding source (GPL-2.0)
#   out/doom/SOURCE.md                           where it comes from and how to rebuild it
#
#   ./package_doom.sh [commit]    (default: the commit the engine files were built from)
set -eu

REPO=https://github.com/lukaske/jev-doom-agent.git
COMMIT=${1:-318c32a24851444c1170bf083671c38723f3a35a}
OUT="$(cd "$(dirname "$0")" && pwd)/out/doom"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git clone -q "$REPO" "$TMP/src" && git -C "$TMP/src" checkout -q "$COMMIT"
rm -rf "$OUT" && mkdir -p "$OUT/LICENSES"
cp "$TMP/src/public/engine/chocolate-doom.js" "$TMP/src/public/engine/chocolate-doom.wasm" "$TMP/src/public/engine/chocolate-doom.data" "$OUT/"
cp "$TMP/src/licenses/"* "$OUT/LICENSES/"
# GPL corresponding source: the vendored engine with the state bridge, and the build script.
# (The repository's own web app has no licence and isn't part of what we ship.)
git -C "$TMP/src" archive --format=tar.gz --prefix="chocolate-doom-source-$COMMIT/" "$COMMIT" vendor engine licenses \
  > "$OUT/chocolate-doom-source-$COMMIT.tar.gz"
cat > "$OUT/SOURCE.md" <<MD
# Chocolate Doom (WebAssembly) for app-cargo-laya

\`chocolate-doom.js\`, \`chocolate-doom.wasm\` and \`chocolate-doom.data\` are the Chocolate Doom 3.1.1
engine compiled to WebAssembly with Emscripten 4.0.14, with a small state bridge
(\`vendor/chocolate-doom/src/doom/browser_doom_bridge.c\`), taken unchanged from
$REPO at commit $COMMIT.
\`chocolate-doom.data\` holds Freedoom 2 (freedoom2.wad, Freedoom 0.13.0).

- Chocolate Doom and the bridge: GNU General Public License v2.0 or later
  (LICENSES/CHOCOLATE-DOOM-GPL-2.0.md). The complete corresponding source, including
  the build script (engine/scripts/build_wasm.sh) and the upstream provenance
  (engine/UPSTREAM.md), is in \`chocolate-doom-source-$COMMIT.tar.gz\` next to this file.
- Freedoom: BSD licence (LICENSES/FREEDOOM-COPYING.txt, CREDITS.txt, CREDITS-MUSIC.txt).
- SDL2: zlib licence (LICENSES/SDL2-LICENSE.txt). Emscripten runtime: MIT/NCSA
  (LICENSES/EMSCRIPTEN-LICENSE.txt). See LICENSES/THIRD_PARTY_NOTICES.md.

Used by apps/app-cargo-laya/app/demos/doom.html in https://github.com/Acurast/acurast-example-apps,
where Laya plays the game through the bridge.
MD
ls -l "$OUT" "$OUT/LICENSES"
shasum -a 256 "$OUT"/chocolate-doom.*
