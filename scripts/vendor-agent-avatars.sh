#!/usr/bin/env bash
# Builds web/vendor/agent-avatars/agent-avatars.js: the agents' faces (web/js/faces.js) use
# @jamesalmeida/agent-avatars, a React component, and Faradia's web has no React or bundler. This
# bundles the published packages, unmodified and at these exact versions, with React into one
# minified browser script. Run it to update them, then review the diff of the versions and licenses.
#
#   scripts/vendor-agent-avatars.sh
set -euo pipefail

AVATARS=0.6.0
REACT=18.3.1
ESBUILD=0.24.2

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/web/vendor/agent-avatars"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund --silent \
  "@jamesalmeida/agent-avatars@$AVATARS" "react@$REACT" "react-dom@$REACT" "esbuild@$ESBUILD"
cp "$here/scripts/vendor/agent-avatars-entry.js" entry.js
mkdir -p "$out"
npx esbuild entry.js --bundle --minify --format=iife --target=es2020 \
  --define:process.env.NODE_ENV='"production"' --legal-comments=none --outfile="$out/agent-avatars.js"

{
  echo "agent-avatars.js bundles these packages, each under the MIT License:"
  for pkg in @jamesalmeida/agent-avatars react react-dom scheduler; do
    echo
    echo "==== $pkg $(node -p "require('./node_modules/$pkg/package.json').version")"
    echo
    cat "node_modules/$pkg/LICENSE"
  done
} >"$out/LICENSE"

cat >"$out/SOURCE.md" <<NOTE
# Agent avatars

- [@jamesalmeida/agent-avatars](https://github.com/jamesalmeida/agent-avatars) $AVATARS (MIT, © James Almeida)
- React and React DOM $REACT (MIT, © Meta Platforms)

\`agent-avatars.js\` is built by \`scripts/vendor-agent-avatars.sh\` from these npm packages, unmodified,
with the entry \`scripts/vendor/agent-avatars-entry.js\`. It sets \`window.AgentAvatars\` and makes no
network requests. Licenses: LICENSE.
NOTE
echo "built $out/agent-avatars.js ($(wc -c <"$out/agent-avatars.js") bytes)"
