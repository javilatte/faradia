#!/usr/bin/env bash
# Bundles ponytail's skills (Dietrich Gebert, MIT) with faradia's changes:
#   - no marks in the code: ponytail asks to leave `shortcut: <limit>, <upgrade>` comments; faradia
#     keeps the code clean and has the agent say the limit in its reply instead;
#   - ponytail-debt is left out (it only lists those comments); so are the plugin's hooks (a ledger
#     and a webhook) and ponytail-help / ponytail-gain (about the plugin itself).
#   scripts/vendor-ponytail.sh <path to a ponytail checkout>
set -euo pipefail
src="${1:?path to a ponytail checkout}"
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../vendor/skills"
for s in ponytail ponytail-review ponytail-audit; do
  "$here/vendor-skill.sh" "$src" "skills/$s" https://github.com/DietrichGebert/ponytail "Dietrich Gebert" "MIT" >/dev/null
done
node - "$dest" <<'JS'
const fs = require('fs');
const path = require('path');
const dest = process.argv[2];
const edit = (skill, from, to) => {
  const file = path.join(dest, skill, 'SKILL.md');
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${skill}: text to change not found (ponytail changed upstream)`);
  fs.writeFileSync(file, text.replace(from, to));
};
edit(
  'ponytail',
  '- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.',
  '- Leave no marks in the code: no `shortcut:`, `ponytail:`, TODO or similar notes about the shortcuts you took. If a shortcut has a known limit, say it in your reply (the limit and when to upgrade), not in the code.'
);
for (const skill of ['ponytail-review', 'ponytail-audit']) {
  edit(
    skill,
    '- A shortcut marked with a `shortcut:` (or older `ponytail:`) comment that names its limit is a\n  decision, not a finding, unless the expected load already crosses it.',
    '- A deliberate shortcut with a known limit is a decision, not a finding, unless the expected load\n  already crosses it. Never ask to add marker comments to the code.'
  );
}
for (const skill of ['ponytail', 'ponytail-review', 'ponytail-audit']) {
  fs.appendFileSync(
    path.join(dest, skill, 'SOURCE.md'),
    '\nModified by faradia (scripts/vendor-ponytail.sh): it leaves no marker comments in the code; limits of a shortcut go in the reply.\n'
  );
  const source = path.join(dest, skill, 'SOURCE.md');
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('Copied unmodified by scripts/vendor-skill.sh;', 'Copied by scripts/vendor-skill.sh;'));
}
JS
echo "vendor/skills/ponytail* <- ponytail $(git -C "$src" rev-parse HEAD), without code markers"
