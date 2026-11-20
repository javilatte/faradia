#!/usr/bin/env bash
# Builds Faradia.app, the dictation helper that uses macOS's speech recognition
# (server/voice/apple/transcribe.swift): one universal binary (Apple chips and Intel) inside a minimal
# app bundle. It must be an app: macOS only shows the speech recognition permission dialog to apps,
# and asks it for the app that runs the recognizer. Faradia opens it with `open` (appleEngine.js).
# CI runs this on macOS and the publish workflow puts the result in the npm package: users never
# compile anything. Needs Xcode's command line tools.
#
#   scripts/build-apple-voice.sh [output.app]   (default: server/voice/apple/bin/Faradia.app)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/server/voice/apple/transcribe.swift"
plist="$here/server/voice/apple/Info.plist"
app="${1:-$here/server/voice/apple/bin/Faradia.app}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-apple-voice: only on macOS" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for arch in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -O -target "$arch-apple-macos11" "$src" -o "$work/$arch" -framework Speech
done
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$plist" "$app/Contents/Info.plist"
lipo -create "$work/arm64" "$work/x86_64" -output "$app/Contents/MacOS/faradia-transcribe"
chmod 755 "$app/Contents/MacOS/faradia-transcribe"
# Ad hoc signature for the whole bundle (Apple chips refuse unsigned code).
codesign --force --sign - "$app"
echo "built $app ($(lipo -archs "$app/Contents/MacOS/faradia-transcribe"))"
