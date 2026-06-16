# @lumen/editor-bridge

Connects the Lumen agent runtime to editor extensions (VSCode,
JetBrains, Neovim).

## What's in this package

- `BaseEditorAdapter` — abstract contract for editor IPC.
- `VSCodeEditorAdapter` — wraps VSCode's extension API.
- `JetBrainsEditorAdapter` — wraps the JetBrains `intellij-platform`
  RPC stubs.
- `MockEditorAdapter` — for tests.
- `EditorCommandSchema` and friends for typed command payloads.

The peer dep on `@types/vscode` is optional; this package compiles and
its tests run without the editor installed.

## Architecture

```
┌──────────────────┐  LSP-style commands  ┌────────────┐
│  VSCode / JB     │ ◄──────────────────► │  Lumen     │
│  Extension Host  │                      │  agent     │
└──────────────────┘                      └────────────┘
        ▲                                          ▲
        │ Webview / Tool Window                    │
        ▼                                          ▼
┌──────────────────┐                                │
│  @lumen/         │ ◄──────────────────────────────┘
│  editor-bridge   │  typed command payloads +
│  (this package)  │  BaseEditorAdapter contract
└──────────────────┘
```

## Why a separate package

Putting the editor IPC contract in its own package lets the same
agent runtime be driven from any editor host without leaking
VSCode- or JetBrains-specific types into `@lumen/core`.

## License

MIT
