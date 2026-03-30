# DevTool

A desktop application for managing development workspaces. Organize projects, tasks, and tabs in a unified interface with integrated terminals, editors, browsers, and AI tool support.

Built with Electron, React, and TypeScript.

## Features

**Project Management** -- Add, organize, and switch between projects. Group projects into folders. Support for local directories, remote SSH projects, and shell command projects.

**Task Organization** -- Create tasks within projects. Each task maintains its own set of tabs and layout state independently.

**Split-Pane Layout** -- Horizontal split view with independent left and right panes. Drag tabs between panes.

**Terminal Tabs** -- Full terminal emulation via xterm.js and node-pty. WebGL-accelerated rendering, scrollback preservation, search, clipboard integration, and copy-on-select.

**Browser Tabs** -- Embedded Chromium browser with URL bar, navigation, and DevTools. SOCKS proxy support for remote project access.

**Editor Tabs** -- Monaco editor with syntax highlighting, configurable fonts, line numbers, minimap, word wrap, and auto-save.

**Diff Viewer** -- Git diff visualization with side-by-side rendering and whitespace options.

**AI Tool Integration** -- Dedicated tabs for Claude Code, Codex, and OpenCode. Hook server enables bidirectional communication with AI tools running in terminals.

**Remote SSH Projects** -- Connect to remote machines via SSH with port forwarding, SOCKS proxy tunneling, key authentication, health checks, and auto-reconnection.

**Git Worktree Management** -- Create and delete isolated git worktrees for branch work directly from the UI.

**File Browser** -- Integrated file tree panel for browsing and opening files.

**Git Status** -- Display current branch, changed files, and diffs.

**Multi-Window** -- Open multiple application windows with independent state.

### Install

```bash
npm install
```

This installs dependencies and rebuilds native modules (node-pty) for Electron.

### Development

```bash
npm run dev
```

Starts the app in development mode with hot reload.

### Build

```bash
npm run build          # Production build
npm run build:mac      # Package macOS app
npm run build:linux    # Package Linux app
```

### Install (build + system install)

```bash
./scripts/install.sh
```

Builds and installs the app system-wide. Supports macOS (arm64) and Linux (x86_64, arm64). On macOS it copies to `/Applications`, on Linux it installs to `/opt/DevTool` with a desktop entry and `/usr/local/bin/devtool` symlink.

### Test

```bash
npm test               # Run tests
npm run test:watch     # Run tests in watch mode
```