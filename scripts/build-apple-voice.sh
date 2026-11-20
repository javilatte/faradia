#!/usr/bin/env bash
# Builds faradia-transcribe, the dictation helper that uses macOS's speech recognition
# (server/voice/apple/transcribe.swift), as one universal binary (Apple chips and Intel) with its
# Info.plist inside: macOS refuses speech recognition to a program that does not say why it wants it.
# CI runs this on macOS and the publish workflow puts the result in the npm package: users never
# compile anything. Needs Xcode's command line tools.
#
#   scripts/build-apple-voice.sh [output]   (default: server/voice/apple/bin/faradia-transcribe)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/server/voice/apple/transcribe.swift"
plist="$here/server/voice/apple/Info.plist"
out="${1:-$here/server/voice/apple/bin/faradia-transcribe}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-apple-voice: only on macOS" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for arch in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -O -target "$arch-apple-macos11" "$src" -o "$work/$arch" \
    -framework Speech \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist"
done
mkdir -p "$(dirname "$out")"
lipo -create "$work/arm64" "$work/x86_64" -output "$out"
# lipo drops the linker's ad hoc signature: sign again (Apple chips refuse unsigned code).
codesign --force --sign - --identifier es.jagoan.faradia.transcribe "$out"
chmod 755 "$out"
echo "built $out ($(lipo -archs "$out"))"
