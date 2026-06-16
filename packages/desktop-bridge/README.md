# @lumen/desktop-bridge

Connects the Lumen agent runtime to a Tauri-based desktop client.

## What's in this package

- `BaseDesktopAdapter` — abstract contract for IPC.
- `TauriDesktopAdapter` — wraps `@tauri-apps/api` (optional peer dep).
- `MockDesktopAdapter` — for tests (plain jsdom + vitest).
- IPC payload Zod schemas (typed command / event shapes).

## Architecture

```
┌─────────────────┐  IPC (Tauri commands)  ┌────────────┐
│  Tauri Rust     │ ◄────────────────────► │  Lumen     │
│  (system, fs,   │                        │  agent     │
│   notifications)│                        │            │
└─────────────────┘                        └────────────┘
        ▲                                          ▲
        │ WebView (React)                          │
        ▼                                          ▼
┌─────────────────┐                                │
│  @lumen/desktop-│ ◄──────────────────────────────┘
│  bridge (this)  │  typed IPC payload schemas +
│                 │  BaseDesktopAdapter contract
└─────────────────┘
```

## Why a separate package

Tests for the bridge should not require Tauri. `MockDesktopAdapter`
lets the React UI be tested in plain jsdom + vitest, and lets the CLI
drive the same agent flow in headless mode.

## License

MIT
