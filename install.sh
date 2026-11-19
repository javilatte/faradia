#!/usr/bin/env bash
# Quick installer — no build toolchain required.
# Usage: bash install.sh [--prefix /usr/local]
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --prefix) PREFIX="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

BINDIR="$PREFIX/bin"
SCRIPT="$(dirname "$0")/bin/faradia"

if [[ ! -f "$SCRIPT" ]]; then
    echo "Error: bin/faradia not found. Run from the faradia project directory."
    exit 1
fi

# install -d + install -m: portable across GNU and BSD/macOS install
# (BSD install has no -D flag).
if install -d "$BINDIR" 2>/dev/null && [[ -w "$BINDIR" ]]; then
    install -m 755 "$SCRIPT" "$BINDIR/faradia"
else
    echo "Note: $BINDIR is not writable — trying with sudo."
    sudo install -d "$BINDIR"
    sudo install -m 755 "$SCRIPT" "$BINDIR/faradia"
fi

echo "Installed → $BINDIR/faradia"
echo "Run: faradia --help"
