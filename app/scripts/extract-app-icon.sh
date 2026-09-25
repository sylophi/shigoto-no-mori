#!/usr/bin/env bash
# Extract a macOS .app's icon to a 128px PNG under renderer/app-icons/.
# Usage: scripts/extract-app-icon.sh <path-to-.app> [output-name]
# Output name defaults to the app's basename, lowercased + hyphenated.
set -euo pipefail

APP="${1:-}"
NAME="${2:-}"

if [ -z "$APP" ]; then
  echo "usage: $0 <path-to-.app> [output-name]" >&2
  exit 1
fi

if [ ! -d "$APP" ]; then
  echo "not a directory: $APP" >&2
  exit 1
fi

PLIST="$APP/Contents/Info.plist"
ICON_FILE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$PLIST" 2>/dev/null || true)

if [ -z "$ICON_FILE" ]; then
  echo "no CFBundleIconFile in $PLIST" >&2
  exit 1
fi

# PlistBuddy sometimes returns the name without the .icns extension.
case "$ICON_FILE" in
  *.icns) ;;
  *) ICON_FILE="${ICON_FILE}.icns" ;;
esac

ICNS="$APP/Contents/Resources/$ICON_FILE"
if [ ! -f "$ICNS" ]; then
  echo "icon not found at $ICNS" >&2
  exit 1
fi

if [ -z "$NAME" ]; then
  BASE=$(basename "$APP" .app)
  NAME=$(echo "$BASE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
fi

OUT="renderer/app-icons/$NAME.png"
mkdir -p "$(dirname "$OUT")"
sips -s format png "$ICNS" --out "$OUT" -Z 128 > /dev/null
echo "wrote $OUT"
