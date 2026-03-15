#!/bin/bash
set -e

APP_NAME="DevTool"
DIST_PATH="dist/mac-arm64/${APP_NAME}.app"
INSTALL_PATH="/Applications/${APP_NAME}.app"

# Kill running instance
if pgrep -x "$APP_NAME" > /dev/null 2>&1; then
  echo "Stopping ${APP_NAME}..."
  killall "$APP_NAME" 2>/dev/null || true
  sleep 1
fi

# Build
echo "Building..."
npm run build:mac

# Install
echo "Installing to ${INSTALL_PATH}..."
rm -rf "$INSTALL_PATH"
cp -R "$DIST_PATH" "$INSTALL_PATH"

# Clear macOS cache
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -kill -r -domain local -domain system -domain user 2>/dev/null || true

echo "Done. Launch ${APP_NAME} from /Applications."
