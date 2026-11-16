#!/bin/bash
set -euo pipefail

FACTORY_MACOS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_APP="$FACTORY_MACOS_ROOT/build/theFactory.app"
swift build --package-path "$FACTORY_MACOS_ROOT" --configuration release
FACTORY_BIN="$(swift build --package-path "$FACTORY_MACOS_ROOT" --configuration release --show-bin-path)"
mkdir -p "$FACTORY_APP/Contents/MacOS" "$FACTORY_APP/Contents/Resources"
cp "$FACTORY_BIN/FactoryMenuBar" "$FACTORY_APP/Contents/MacOS/FactoryMenuBar"
cat > "$FACTORY_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>CFBundleName</key><string>theFactory</string>
    <key>CFBundleDisplayName</key><string>theFactory</string>
    <key>CFBundleIdentifier</key><string>dev.thefactory.menubar</string>
    <key>CFBundleExecutable</key><string>FactoryMenuBar</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSHumanReadableCopyright</key><string>theFactory contributors</string>
</dict></plist>
PLIST
FACTORY_NODE_PATH="$(command -v node)"
plutil -insert FactoryNodePath -string "$FACTORY_NODE_PATH" "$FACTORY_APP/Contents/Info.plist"
plutil -insert FactoryCLIPath -string "$FACTORY_MACOS_ROOT/../bin/theFactory.js" "$FACTORY_APP/Contents/Info.plist"
codesign --force --sign - "$FACTORY_APP"
printf 'Built %s\n' "$FACTORY_APP"

if [[ "${1:-}" == "--install" ]]; then
    FACTORY_INSTALL_DIR="$HOME/Applications"
    FACTORY_INSTALLED_APP="$FACTORY_INSTALL_DIR/theFactory.app"
    mkdir -p "$FACTORY_INSTALL_DIR"
    # Replace only an earlier build of this exact companion.
    if [[ -e "$FACTORY_INSTALLED_APP" ]]; then
        FACTORY_EXISTING_ID=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$FACTORY_INSTALLED_APP/Contents/Info.plist" 2>/dev/null || true)
        if [[ "$FACTORY_EXISTING_ID" != "dev.thefactory.menubar" ]]; then
            printf 'Refusing to replace a different app at %s\n' "$FACTORY_INSTALLED_APP" >&2
            exit 1
        fi
        if pgrep -x FactoryMenuBar >/dev/null; then
            printf 'Quit theFactory menu bar companion, then run the install command again.\n' >&2
            exit 1
        fi
    fi
    ditto "$FACTORY_APP" "$FACTORY_INSTALLED_APP"
    printf 'Installed %s\n' "$FACTORY_INSTALLED_APP"
    open "$FACTORY_INSTALLED_APP"
fi
