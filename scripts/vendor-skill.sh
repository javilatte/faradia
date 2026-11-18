#!/usr/bin/env bash
# Copies one third-party skill, unmodified, into vendor/skills/<name>, with its LICENSE and a
# SOURCE.md that keeps the attribution. optimia gives it to every session (server/skills/library.js).
#   scripts/vendor-skill.sh <checkout> <skill folder inside it> <repo URL> "<author>" "<license>"
# The bundled ones:
#   scripts/vendor-skill.sh ../unslop skills/unslop https://github.com/heydamir/unslop "Damir Sokolovsky (@heydamir)" "CC BY 4.0"
#   scripts/vendor-skill.sh ../security-audit-skill skills/security-audit https://github.com/cloudflare/security-audit-skill "Cloudflare, Inc." "MIT"
#   scripts/vendor-skill.sh ../seangeng-skills plan-optimizer https://github.com/seangeng/skills "Sean Geng" "MIT"
# ponytail goes through scripts/vendor-ponytail.sh, which also removes its code markers.
set -euo pipefail
src="${1:?checkout}"; sub="${2:?skill folder}"; url="${3:?repo URL}"; author="${4:?author}"; license="${5:?license}"
name="$(basename "$sub")"
dest="$(cd "$(dirname "$0")/.." && pwd)/vendor/skills/$name"
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
cp -R "$src/$sub" "$dest"
cp "$src/LICENSE" "$dest/LICENSE"
commit="$(git -C "$src" rev-parse HEAD)"
cat > "$dest/SOURCE.md" <<MD
# $name

The $name skill from $url (folder \`$sub\`, commit \`$commit\`), by $author, under the
$license license (see LICENSE in this folder). Copied unmodified by scripts/vendor-skill.sh;
optimia gives it to every chat and agent session as /$name.
MD
echo "vendor/skills/$name <- $url $commit"
