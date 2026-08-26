# Architecture

## Overview

pi-lsp-lite is a [pi extension](https://github.com/mariozechner/pi) that hooks into the `tool_result` event for `write` and `edit` tool calls. When a supported file is modified, it routes the file through a long-lived LSP server and appends diagnostics to the tool result.

## Module layout

```text
index.ts               → extension entry point
src/
  config.ts            → config file loading, merge, and write
  languages.ts         → built-in language server defaults
  install-registry.ts  → known install commands for built-in servers
  client.ts            → LSP protocol client (JSON-RPC over stdio)
  server-manager.ts    → server lifecycle and edit orchestration
  format.ts            → diagnostic formatting for agent consumption
  util.ts              → file URI, binary lookup, workspace root detection
test/
  fake-server.ts       → minimal LSP server for unit tests
  *.test.ts            → unit tests (no real servers)
  integration/         → real server tests (guarded by INTEGRATION env)
```

## Data flow

```text
agent calls write/edit
  → pi executes the tool, writes the file
  → tool_result event fires
  → index.ts: check file extension, resolve absolute path, enforce cwd boundary
  → server-manager.ts: find workspace root, ensure server, queue edit
  → client.ts: send didOpen/didChange, then pull diagnostics or wait for a push update
  → format.ts: filter to errors+warnings, add source context, format compiler-style text and cross-file details
  → index.ts: append formatted text to tool_result content
```

## Key design choices

### Per-URI generation counter

Each `didOpen` and `didChange` increments a generation counter for that URI. The `publishDiagnostics` handler discards notifications from a different generation. This stops an old open or close cycle from changing the current state. Pull reports update the same stored entry and keep their `resultId` for the next request.

### Serialized edits per server

Each `ManagedServer` has an `editQueue` promise chain. Edits to the same server are serialized so that `waitForDiagnostics` never has concurrent waiters on the same client. Different servers (different languages or different workspace roots) run in parallel.

### Pull and push diagnostics

The client advertises LSP 3.17 document diagnostic support and related diagnostic information. If the server returns a `diagnosticProvider`, the client sends `textDocument/diagnostic` after each edit. It stores each `resultId` and sends it as `previousResultId` on the next request. Full reports replace the stored pull diagnostics, while unchanged reports keep them.

The client stores push and pull diagnostics separately. A full pull clears push diagnostics for the same URI when they predate the request. Push diagnostics that arrive during or after the pull remain in the merged result. After all pull requests finish, a 200 ms quiet period collects project diagnostics that the server sends through `publishDiagnostics`.

For pull servers with `interFileDependencies`, the client pulls every open document. It also accepts `relatedDocuments` from each report. This detects errors in a caller when an edit changes a library.

Older servers use push diagnostics. Before the wait starts, the client stores the error and warning fingerprints for all tracked URIs. A target update or a changed related file starts a 200 ms quiet period. The quiet period collects notifications that arrive close together.

A push server can omit a notification when diagnostics do not change. After the target has one validated snapshot, a missing update returns a non-retryable timeout with that snapshot. An initial validation without a notification returns a retryable timeout. This avoids duplicate retries without presenting an old snapshot as current.

If the initial validation or a pull request times out, the server manager retries the edit. The delay starts at 500 ms and doubles for each attempt. Jitter adds up to 50 percent, and the delay has a 30 second limit. The default is three retries. The final result includes `retryAttempts` and any cross-file data collected before the timeout.

Pull timeouts cancel active requests and ignore late reports. A server cancellation retries only when `retriggerRequest` is true or absent. A false value returns a non-retryable partial result. The server manager keeps cross-file diagnostics from all attempts.

```text
handleEdit(lib.ts):
  snapshot: { caller.ts: {errors:0} }
  send didChange(lib.ts)
  │
  ├─ server publishes for caller.ts: [{error}]
  │  crossFileCallback: pre={errors:0}, post={errors:1} → CHANGED
  │  → start 200ms quiescence
  │
  ├─ server publishes for type_error.ts: [] (stale re-publish)
  │  crossFileCallback: pre={errors:0}, post={errors:0} → UNCHANGED
  │  → ignored
  │
  ├─ 200ms pass, no more publishes
  │  → settle("ok")
  │
  └─ result: { status:"ok", diagnostics:[], otherFiles:[{caller.ts, errors:1, topDiagnostics:[...]}] }
```

### Diagnostic output

The server manager reads an edited document once and sends that content to the server. The diagnostic result contains the same content, so the formatter avoids a second file read. Each excerpt matches the content that the server checked.

Each diagnostic uses `path:line:column: severity[code]: message [source]`. The formatter omits absent codes and sources. It shows the source line for the first five target-file diagnostics. It trims each source line and limits it to 120 characters.

The client requests `relatedInformation` and keeps the full `Diagnostic` objects. The formatter shows at most two related locations per diagnostic. It converts file URIs to paths relative to the session directory.

For each changed cross-file result, the client keeps up to three diagnostics. Errors come before warnings. The cross-file footer uses the same line formatter as target-file results and `/lsp-diag`.

### Per-language diagnostic timeouts

Each built-in language server has a default diagnostic timeout calibrated to its real-world performance:

| Server        | Timeout | Rationale                                                                |
| ------------- | ------- | ------------------------------------------------------------------------ |
| gopls         | 5s      | Fast indexing, quick diagnostics even on cold start                      |
| rust-analyzer | 30s     | Slow cold start, needs workspace indexing time                           |
| tsgo          | 30s     | A cold workspace can still need project loading before the first pull    |
| pylsp         | 15s     | Moderate cold start, plugin-dependent analysis speed                     |
| clangd        | 15s     | Fast for single files, slower for projects without compile_commands.json |

Timeouts are per-attempt — with the default `maxRetries: 3`, the worst-case total wait for rust-analyzer is 4 × 30s + backoff ≈ 2 minutes. Timeouts are overridable via `.pi-lsp-lite.json` (global `diagnosticTimeout` or per-server `servers.<id>.diagnosticTimeout`).

### Workspace root detection

`findWorkspaceRoot()` walks up from the edited file looking for root markers (`go.mod`, `Cargo.toml`, `tsconfig.json`, `package.json`), bounded by the session's `cwd`. Different roots spawn different server instances, keyed by `${languageId}:${root}`.

### Server lifecycle

- Lazy start on first relevant edit
- Idle shutdown after 240s of no edits
- Periodic 60s sweep closes documents idle > 120s
- Session shutdown uses SIGTERM → SIGKILL escalation with 5s grace

### Failure isolation

- Missing binary: disables that language for the session
- Init failure: disables only that specific root (serverKey), other roots unaffected
- Both return `status: "unavailable"` so the agent isn't told the file is clean when it's actually unchecked

## Configuration loading

Config is loaded in three layers at `session_start`:

1. **Built-in defaults** from `src/languages.ts` (go, rust, typescript, python, c/c++)
2. **Global config** from `~/.pi-lsp-lite.json`
3. **Project config** from `.pi-lsp-lite.json` or `.pi/lsp-lite.json` in the session's cwd

Each layer merges over the previous:

- New server IDs are added (global config only — project config cannot define new servers for security)
- Existing server IDs are partially overridden (only specified fields change)
- Project config can tune safe local behaviour (`disabled`, per-server timeout, `maxRetries`) but cannot override trusted server shape (`command`, `args`, `extensions`, `rootPatterns`) for any existing server
- Global config owns executable/server-shape changes, including custom servers and command/argv overrides
- `"disabled": true` removes the server entirely (re-enabling in a later layer requires redefining the full server config)
- Timeout overrides (`diagnosticTimeout`, `documentIdleTimeout`) cascade from global to per-server
- Timeout values are clamped to safe bounds

Config is not hot-reloaded — `/reload` picks up changes via `session_start`.

## Extension hooks used

| Hook               | Purpose                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `tool_result`      | Intercept write/edit results, append diagnostics                                     |
| `session_start`    | Load config, create server manager                                                   |
| `session_shutdown` | Kill all servers                                                                     |
| `registerCommand`  | `/lsp-status`, `/lsp-diag`, `/lsp-add`, `/lsp-remove`, `/lsp-toggle`, `/lsp-install` |

## Adding a language

For built-in defaults, add an entry to `builtinLanguages` in `src/languages.ts`. For user-added servers, create a global `~/.pi-lsp-lite.json` entry:

```json
{
  "servers": {
    "python": {
      "extensions": [".py"],
      "command": "pylsp",
      "args": [],
      "rootPatterns": ["pyproject.toml", "setup.py"]
    }
  }
}
```

The server manager handles the rest — spawn, lifecycle, diagnostics collection.
