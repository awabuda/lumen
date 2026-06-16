# @lumen/tools

Default tool implementations for the Lumen agent. Every tool in this
package extends `BaseTool` from `@lumen/core`, declares its input and
output as Zod schemas, and resolves user-supplied paths against the
caller's `ctx.cwd`.

## Tool groups

| Group | Tools |
|---|---|
| `createFilesystemTools()` | `read_file`, `write_file`, `patch`, `list_directory`, `search_files` |
| `createShellTools()` | `terminal_run`, with pluggable `ShellSandbox` |
| `createGitTools()` | `git_status`, `git_diff`, `git_commit`, `git_log` |
| `createGhTools()` | `gh_pr_create`, `gh_issue_list`, etc. |
| `createWebTools()` | `web_search`, `web_fetch` |
| `createMetaTools()` | `date`, `env`, `whoami` |
| `chunkTextTool` | `chunk_text` — char / paragraph / sentence splitter with overlap (CJK-aware) |

## Quick start

```ts
import { ToolRegistry } from '@lumen/core'
import {
  createFilesystemTools,
  createShellTools,
  createGitTools,
} from '@lumen/tools'

const registry = new ToolRegistry()
registry.registerAll([
  ...createFilesystemTools(),
  ...createShellTools(),
  ...createGitTools(),
])
```

Each tool checks `ctx.signal` in long loops so the agent can cancel
cooperatively.

## Sandboxing

`createShellTools({ sandbox })` accepts a `ShellSandbox` implementation.
`@lumen/tools` ships a Docker sandbox and a no-op (passthrough) sandbox;
custom sandboxes can wrap Landrun, bubblewrap, or any other primitive.

## License

MIT
