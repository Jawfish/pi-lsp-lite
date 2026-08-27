# pi-lsp-lite

[![CI](https://img.shields.io/github/actions/workflow/status/mcphailtom/pi-lsp-lite/ci.yml?branch=main&label=CI)](https://github.com/mcphailtom/pi-lsp-lite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-lsp-lite)](https://www.npmjs.com/package/pi-lsp-lite)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Your agent can't see compiler errors. Now it can.

[pi](https://github.com/mariozechner/pi) extension that runs language servers in the background and feeds diagnostics back inline after every edit. Errors appear on the same turn — no context switch, no separate command.

The extension supports Go, Rust, TypeScript, Python, and C/C++.

## Install

```bash
pi install npm:pi-lsp-lite
```

That's it. If you have `gopls`, `rust-analyzer`, `tsgo`, `pylsp`, or `clangd` on PATH, diagnostics start flowing automatically.

## What you see

```text
  edit ─ src/main.go
  ✓ Edited src/main.go (replaced 2 lines)

  ⚠ LSP diagnostics for src/main.go (2 errors):
    src/main.go:12:5: error[UndeclaredName]: undefined: foo [compiler]
      | return foo()
      ↳ src/helpers.go:3:1: foo was declared here
    src/main.go:18:2: error[WrongArgCount]: too many arguments in call to bar [compiler]
      | bar(first, second)
    src/caller.go (2 errors):
    src/caller.go:8:3: error[UnknownField]: unknown field value [compiler]
    src/caller.go:14:7: error[TypeMismatch]: cannot use string as int [compiler]
```

The extension appends these diagnostics to the tool result, so the agent can self-correct in the same turn. The first five diagnostics include a source line, trimmed to 120 characters. Each diagnostic can show two related locations. A changed cross-file result can show three diagnostics per file, with errors first.

Validation blocks the tool result for at most `softDeadline` (10 seconds by default). If validation continues and finds different diagnostics, the extension injects the final result as an `lsp-lite-diagnostics` message. It does not start a model turn while the agent is idle.

## Bash changes

The extension also checks files after agent `bash` tools and user `!` commands. Before the command, it snapshots each open document and workspace marker. After the command, it compares file modification times and sizes. It skips this work when no language server is running.

The extension reads each changed open document again, sends it to its server, and validates it. For a deleted document, it sends `didClose` and removes the stored diagnostics. A server that registers for `workspace/didChangeWatchedFiles` also receives events for changed documents and root markers such as `go.mod`, `Cargo.toml`, `tsconfig.json`, `package.json`, and `compile_commands.json`.

Agent `bash` diagnostics append to the tool result when ready before the soft deadline. Later results use the same deduplicated `lsp-lite-diagnostics` message as write and edit tools. Pi queues results from user `!` commands for the next turn. These messages leave an idle pi session idle.

## Commands

| Command        | What it does                                                            |
| -------------- | ----------------------------------------------------------------------- |
| `/lsp-status`  | Show running servers, PIDs, workspace roots, uptime                     |
| `/lsp-reload`  | Reload config now and report what changed                               |
| `/lsp-diag`    | Show all current diagnostics (or `/lsp-diag path/to/file` for one file) |
| `/lsp-add`     | Interactively add a new language server                                 |
| `/lsp-remove`  | Disable a configured server                                             |
| `/lsp-toggle`  | Flip a server on/off without removing config                            |
| `/lsp-install` | Install a missing server binary                                         |

## Supported servers

| Server          | Language      | Install                                                                                     |
| --------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `gopls`         | Go            | `go install golang.org/x/tools/gopls@latest`                                                |
| `rust-analyzer` | Rust          | `rustup component add rust-analyzer`                                                        |
| `tsgo`          | TypeScript/JS | `npm install -g @typescript/native-preview`                                                 |
| `pylsp`         | Python        | `python3 -m pip install python-lsp-server` / Windows: `py -m pip install python-lsp-server` |
| `clangd`        | C/C++         | Xcode CLI tools / `apt install clangd`                                                      |

Missing a server? `/lsp-add` lets you configure any LSP server that speaks stdio. Or add it to global config (`~/.pi-lsp-lite.json`):

```json
{
  "servers": {
    "haskell": {
      "extensions": [".hs"],
      "command": "haskell-language-server-wrapper",
      "args": ["--lsp"],
      "rootPatterns": ["cabal.project", "stack.yaml"]
    }
  }
}
```

## Configuration

Works without config. Use project config (`.pi-lsp-lite.json` or `.pi/lsp-lite.json`) for safe local tuning, and global config (`~/.pi-lsp-lite.json`) for trusted executable/server-shape changes like custom servers, `command`, `args`, `extensions`, and `rootPatterns`:

| Field                            | Description                      | Default      |
| -------------------------------- | -------------------------------- | ------------ |
| `servers.<id>.diagnosticTimeout` | Per-attempt timeout (ms)         | per-language |
| `servers.<id>.maxRetries`        | Retry attempts on timeout (0-10) | `3`          |
| `servers.<id>.disabled`          | Disable this server              | `false`      |
| `diagnosticTimeout`              | Global default timeout (ms)      | `5000`       |
| `documentIdleTimeout`            | Close idle documents after (ms)  | `120000`     |
| `softDeadline`                   | Maximum blocking wait (ms)       | `10000`      |

Project config merges over global for safe tuning fields. Repositories can disable servers and tune timeouts, retries, and the soft deadline, but they cannot change the executable, argv, extensions, or root patterns for any existing server; put those trusted changes in global config. `softDeadline` is clamped from 1000 to 60000 ms.

The extension watches all three config files and applies edits after a 300 ms debounce. It restarts language servers only when the resolved config changes. Whitespace and unknown keys do not cause a restart. Use `/lsp-reload` to check and apply config on demand.

## How it works

1. Agent writes or edits a file
2. Extension detects the language, finds the workspace root
3. Spawns (or reuses) an LSP server for that language + root
4. Sends `didChange`, then pulls diagnostics when the server supports LSP 3.17 diagnostic requests
5. Falls back to push diagnostics for older servers
6. Waits up to `softDeadline`, then appends the diagnostics known so far
7. Continues timed-out validation and retries in the background
8. Injects a final custom message only when its diagnostic fingerprints differ
9. Filters errors and warnings, then formats the result for agent context and the TUI

For pull servers with inter-file dependencies, the extension checks all open documents after an edit. Push servers compare each notification with the stored snapshot. When no unchanged result arrives, the extension reports one incomplete result with its last validated snapshot and skips duplicate retries.

Servers are lazy (spawn on first edit), idle-shutdown after 240s, and clean up on session end.

## Development

```bash
git clone https://github.com/mcphailtom/pi-lsp-lite
cd pi-lsp-lite && npm install
npm run check              # typecheck
npm test                   # unit tests (no servers needed)
npm run test:integration   # real server tests (needs servers on PATH, including tsgo)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

[MIT](LICENSE)
