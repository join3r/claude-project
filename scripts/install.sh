#!/bin/bash
set -e

APP_NAME="DevTool"
OS="$(uname -s)"

# Ensure caches are in a writable location if ~/.cache is read-only
if ! touch "$HOME/.cache/.writetest" 2>/dev/null; then
  CACHE_DIR="${TMPDIR:-/tmp}/devtool-cache"
  mkdir -p "$CACHE_DIR"
  export XDG_CACHE_HOME="$CACHE_DIR"
  export ELECTRON_CACHE="$CACHE_DIR/electron"
  export ELECTRON_BUILDER_CACHE="$CACHE_DIR/electron-builder"
  mkdir -p "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE"
  # Copy any existing cached electron downloads
  if [ -d "$HOME/.cache/electron" ]; then
    cp -rn "$HOME/.cache/electron/"* "$ELECTRON_CACHE/" 2>/dev/null || true
  fi
else
  rm -f "$HOME/.cache/.writetest"
fi

# Kill running instance
if pgrep -x "$APP_NAME" > /dev/null 2>&1; then
  echo "Stopping ${APP_NAME}..."
  killall "$APP_NAME" 2>/dev/null || true
  sleep 1
fi

if [ "$OS" = "Darwin" ]; then
  DIST_PATH="dist/mac-arm64/${APP_NAME}.app"
  INSTALL_PATH="/Applications/${APP_NAME}.app"

  echo "Building for macOS..."
  npm run build:mac

  echo "Installing to ${INSTALL_PATH}..."
  rm -rf "$INSTALL_PATH"
  cp -R "$DIST_PATH" "$INSTALL_PATH"

  # Clear macOS launch services cache
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -kill -r -domain local -domain system -domain user 2>/dev/null || true

  echo "Done. Launch ${APP_NAME} from /Applications."

elif [ "$OS" = "Linux" ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  DIST_DIR="dist/linux-unpacked" ;;
    aarch64) DIST_DIR="dist/linux-arm64-unpacked" ;;
    *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
  esac
  INSTALL_PATH="/opt/${APP_NAME}"
  BIN_LINK="/usr/local/bin/devtool"

  echo "Building for Linux..."
  npm run build:linux

  # Find the actual binary name from build output (electron-builder lowercases it)
  BIN_NAME=$(find "$DIST_DIR" -maxdepth 1 -type f -executable ! -name "*.so" ! -name "chrome-*" ! -name "lib*" | head -1)
  BIN_NAME=$(basename "$BIN_NAME")
  if [ -z "$BIN_NAME" ]; then
    echo "Error: could not find executable in $DIST_DIR"
    exit 1
  fi

  echo "Installing to ${INSTALL_PATH}..."
  sudo rm -rf "$INSTALL_PATH"
  sudo cp -R "$DIST_DIR" "$INSTALL_PATH"
  sudo ln -sf "${INSTALL_PATH}/${BIN_NAME}" "$BIN_LINK"

  # Install .desktop file
  sudo sh -c "printf '[Desktop Entry]\nName=${APP_NAME}\nExec=${INSTALL_PATH}/${BIN_NAME}\nTerminal=false\nType=Application\nCategories=Development;\n' > /usr/share/applications/devtool.desktop"
  sudo update-desktop-database /usr/share/applications 2>/dev/null || true

  echo "Done. Launch ${APP_NAME} from your app menu or run 'devtool'."

else
  echo "Unsupported OS: $OS"
  exit 1
fi
