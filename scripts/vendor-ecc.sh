#!/usr/bin/env bash
# Copies the agents, skills and commands of ECC (Everything Claude Code, MIT) into vendor/ecc.
#   scripts/vendor-ecc.sh <path to an ECC checkout>
# optimia bundles them: no Claude Code plugin is installed (see server/ecc/library.js).
set -euo pipefail
src="${1:?path to an ECC checkout}"
dest="$(cd "$(dirname "$0")/.." && pwd)/vendor/ecc"
rm -rf "$dest"
mkdir -p "$dest"
cp "$src/LICENSE" "$dest/LICENSE"
cp -R "$src/agents" "$dest/agents"
cp -R "$src/skills" "$dest/skills"
cp -R "$src/commands" "$dest/commands"
commit="$(git -C "$src" rev-parse HEAD)"
cat > "$dest/SOURCE.md" <<MD
# ECC (Everything Claude Code)

Agents, skills and commands from https://github.com/affaan-m/ECC, commit \`$commit\`,
by Affaan Mustafa, under the MIT License (see LICENSE in this folder). Copied unmodified by
scripts/vendor-ecc.sh; optimia lists them in Settings and passes the ones you enable to its sessions.
MD
echo "vendor/ecc <- ECC $commit"
