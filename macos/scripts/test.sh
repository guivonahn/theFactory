#!/bin/bash
set -euo pipefail
FACTORY_MACOS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/factory-status-checks.XXXXXX")"
trap 'rm -rf "$FACTORY_CHECK_DIR"' EXIT
swiftc -D FACTORY_STATUS_CHECKS -parse-as-library \
    "$FACTORY_MACOS_ROOT"/Sources/FactoryMenuBar/*.swift \
    "$FACTORY_MACOS_ROOT/Tests/SessionReaderChecks.swift" \
    -o "$FACTORY_CHECK_DIR/StatusChecks"
"$FACTORY_CHECK_DIR/StatusChecks" "$@"
