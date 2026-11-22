#!/usr/bin/env bash
# Bundles the humanizer skill (Siqi Chen, @blader, MIT), unmodified, into vendor/skills/humanizer.
# Its SKILL.md lives at the root of its repo, next to plugin files Faradia does not need, so only
# SKILL.md and LICENSE are copied. Faradia sends the writing stages to it (server/bridge/taskStages.js).
#   scripts/vendor-humanizer.sh <path to a blader/humanizer checkout>
set -euo pipefail
src="${1:?path to a blader/humanizer checkout}"
dest="$(cd "$(dirname "$0")/.." && pwd)/vendor/skills/humanizer"
url=https://github.com/blader/humanizer
rm -rf "$dest"
mkdir -p "$dest"
cp "$src/SKILL.md" "$src/LICENSE" "$dest/"
commit="$(git -C "$src" rev-parse HEAD)"
cat > "$dest/SOURCE.md" <<MD
# humanizer

The humanizer skill from $url (file \`SKILL.md\`, commit \`$commit\`), by Siqi Chen (@blader), under
the MIT license (see LICENSE in this folder). Copied unmodified by scripts/vendor-humanizer.sh;
faradia gives it to every chat and agent session as /humanizer, and its writing stages (documents,
pull request and Jira descriptions, commit messages, README and docs) follow it before they finish.
MD
echo "vendor/skills/humanizer <- $url $commit"
