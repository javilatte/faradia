#!/usr/bin/env bash
# Bundles part of pstack (Lauren Tan, MIT), unmodified, from the Claude Code copy in cursor/plugins:
#   - skills that work outside Cursor and fit faradia's sessions -> vendor/skills/<name>;
#   - the 24 principles -> vendor/pstack/principles/<name>: faradia puts the ones that fit each agent
#     in its prompt (server/agents/catalog.js), so they stay out of the / menu;
#   - the Comment Sicko agent and the Claude Code adapter the skills link to -> vendor/pstack.
# Left out: poteto-mode and its router (faradia's pipelines do that job), statechart (needs TLA+ and
# ships 4 MB of test corpus), and the Cursor-only or personal ones.
#   scripts/vendor-pstack.sh <path to a cursor/plugins checkout>
set -euo pipefail
src="${1:?path to a cursor/plugins checkout}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/.."
harness="harness/pstack/claude-code"
url=https://github.com/cursor/plugins
skills="correct tdd blast-radius why how architect arena in-your-own-words interrogate no-comments benchmark-checklist create-verification-skill maintain-verification-skill"
for s in $skills; do
  LICENSE_FILE="$harness/LICENSE" "$here/vendor-skill.sh" "$src" "$harness/skills/$s" "$url" "Lauren Tan (poteto)" "MIT" >/dev/null
done
rm -rf "$root/vendor/pstack"
mkdir -p "$root/vendor/pstack/principles" "$root/vendor/pstack/agents" "$root/vendor/pstack/docs/harness"
for d in "$src/$harness"/skills/principle-*; do
  cp -R "$d" "$root/vendor/pstack/principles/$(basename "$d" | sed 's/^principle-//')"
done
cp "$src/$harness/agents/comment-sicko.md" "$root/vendor/pstack/agents/"
cp "$src/$harness/docs/harness/claude-code.md" "$root/vendor/pstack/docs/harness/"
cp "$src/$harness/LICENSE" "$root/vendor/pstack/LICENSE"
commit="$(git -C "$src" rev-parse HEAD)"
cat > "$root/vendor/pstack/SOURCE.md" <<MD
# pstack

The principles, the Comment Sicko agent and the Claude Code adapter of pstack, from $url (folder
\`$harness\`, commit \`$commit\`), by Lauren Tan (poteto), under the MIT license (see LICENSE in this
folder). Copied unmodified by scripts/vendor-pstack.sh. faradia adds the principles that fit each of
its agents to that agent's prompt, and the Comment Sicko text to the comments stage. The pstack
skills it bundles are in vendor/skills, each with its own SOURCE.md.
MD
echo "vendor/skills + vendor/pstack <- $url $commit"
