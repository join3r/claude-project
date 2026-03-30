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

## Tech Stack

| Component | Technology |
|---|---|
| Desktop shell | Electron 35 |
| UI framework | React 19 |
| Language | TypeScript 5.9 |
| Build tool | Vite 7 via electron-vite |
| Terminal | xterm.js 6 + node-pty |
| Code editor | Monaco Editor |
| Testing | Vitest |
| Packaging | electron-builder |

## Getting Started

### Prerequisites

- Node.js (LTS recommended)
- npm
- macOS (primary target)

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
```

### Test

```bash
npm test               # Run tests
npm run test:watch     # Run tests in watch mode
```

## Project Structure

```
src/
  main/                 Electron main process
    index.ts            Entry point, app lifecycle, menus
    app-runtime.ts      Core runtime, IPC handler registration
    pty-manager.ts      PTY spawning and lifecycle
    storage.ts          JSON-based persistence (~/.devtool/)
    ssh-connection-manager.ts   SSH connection pooling and tunneling
    hook-server.ts      HTTP server for AI tool hooks
    workspace-manager.ts        Git worktree operations

  renderer/             React UI (renderer process)
    App.tsx             Root component
    context/            React context providers
    hooks/              State management and utilities
    components/
      Sidebar.tsx       Project and task navigation
      ContentArea.tsx   Main content with split panes
      TabBar.tsx        Tab management
      TerminalTab.tsx   Terminal emulation
      EditorTab.tsx     Monaco editor
      BrowserTab.tsx    Embedded browser
      DiffTab.tsx       Git diff viewer
      AiToolTab.tsx     AI tool integration
      FileBrowserPanel.tsx   File tree

  preload/              IPC bridge between main and renderer
  shared/               Shared TypeScript types
```

## Configuration

Application data is stored in `~/.devtool/`:

- `config.json` -- App settings (fonts, theme, shell, editor preferences)
- `projects.json` -- Projects, tasks, tabs, and view state
- `window-session.json` -- Multi-window layout state
- `scrollback/` -- Terminal scrollback history

### Settings

- **Theme** -- System, dark, or light
- **Terminal** -- Font family (Nerd Font support), font size, shell selection
- **Editor** -- Font, size, word wrap, line numbers, minimap, tab size
- **Diff** -- Side-by-side mode, whitespace handling

## License

Private.
