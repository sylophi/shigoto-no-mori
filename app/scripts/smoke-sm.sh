#!/usr/bin/env bash
# Runs a built terminal sm through each verb a release depends on: the
# version, the store opened and read, and the feed asked. The check needs
# the network, so only a start that failed (a signal, a refused exec, no
# word at all) fails it. Its answer goes to the log.
# Usage: scripts/smoke-sm.sh <path-to-sm> <version>
# Run it on an empty SHIGOMORI_DATA_DIR.
set -euo pipefail

SM="$1"
VERSION="$2"

VERSION_OUT="$("$SM" --version)"
echo "sm --version: $VERSION_OUT"
if [[ "$VERSION_OUT" != *"$VERSION"* ]]; then
  echo "sm --version did not name $VERSION."
  exit 1
fi

PROJECTS_OUT="$("$SM" --json projects list)"
echo "sm --json projects list: $PROJECTS_OUT"
if [[ "$PROJECTS_OUT" != "[]" ]]; then
  echo "sm did not read an empty store."
  exit 1
fi

set +e
CHECK_OUT="$("$SM" --json update --check 2>&1)"
CHECK_EXIT=$?
set -e
echo "sm --json update --check (exit $CHECK_EXIT): $CHECK_OUT"
if (( CHECK_EXIT >= 126 )) || [[ -z "$CHECK_OUT" ]]; then
  echo "sm update --check failed to start."
  exit 1
fi
