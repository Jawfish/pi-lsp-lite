import {
  createLocalBashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createServerManager } from "./src/server-manager.js";
import {
  createWorkingMessageController,
  type ValidationProgress,
  type WorkingMessageController,
} from "./src/progress.js";
import { languageForFile, checkExtensionOverlaps, builtinLanguages, type LanguageServerConfig } from "./src/languages.js";
import { formatDiagnostic, formatDiagnostics } from "./src/format.js";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import {
  loadConfig,
  writeGlobalConfig,
  readGlobalConfig,
  type ResolvedConfig,
} from "./src/config.js";
import {
  applyResolvedConfig,
  compareResolvedConfigs,
  formatConfigChange,
  type ConfigChange,
} from "./src/config-reload.js";
import {
  watchConfigFiles,
  type ConfigWatchHandle,
} from "./src/config-watch.js";
import { fileUri, which, isInsideCwd } from "./src/util.js";
import { installRegistry, installCommandFor } from "./src/install-registry.js";
import { buildServerStates, formatServerStates } from "./src/status.js";
import { resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbortError } from "./src/abort.js";
import { deliverLateDiagnostics } from "./src/late-delivery.js";
import {
  captureBashChangeSnapshot,
  prepareBashDiagnostics,
  queueDiagnosticsAfterBash,
  resyncAfterBash,
  type BashChangeSnapshot,
} from "./src/bash-awareness.js";

export default function (pi: ExtensionAPI) {
  let servers: LanguageServerConfig[] = [];
  let manager = createServerManager({});
  let currentConfig: ResolvedConfig | null = null;
  let reloadTail: Promise<unknown> = Promise.resolve();
  let configWatcher: ConfigWatchHandle | null = null;
  let workingMessageController: WorkingMessageController | null = null;
  let validationProgressHandler: ((event: ValidationProgress) => void) | null = null;
  const pendingNewFiles = new Map<string, boolean>();
  const pendingBashSnapshots = new Map<string, BashChangeSnapshot>();

  function monitorLateDelivery(
    delivery: Promise<void>,
    signal?: AbortSignal,
  ): void {
    void delivery.catch((error: unknown) => {
      if (signal?.aborted || isAbortError(error)) return;
      console.error("[pi-lsp-lite]", error);
    });
  }

  function createConfiguredManager(config: ResolvedConfig) {
    return createServerManager({
      diagnosticTimeout: config.diagnosticTimeout,
      documentIdleTimeout: config.documentIdleTimeout,
      perServerTimeout: config.perServerTimeout,
      softDeadline: config.softDeadline,
      onValidationProgress: (event) => validationProgressHandler?.(event),
    });
  }

  async function reloadConfigNow(cwd: string): Promise<ConfigChange> {
    const resolved = await loadConfig(cwd);
    const change = compareResolvedConfigs(currentConfig, resolved);
    if (!change.changed) return change;

    pendingBashSnapshots.clear();
    const applied = await applyResolvedConfig(
      { config: currentConfig, manager },
      resolved,
      createConfiguredManager,
    );
    currentConfig = applied.runtime.config;
    manager = applied.runtime.manager;
    servers = resolved.servers;

    for (const warning of checkExtensionOverlaps(servers)) {
      console.error(`[pi-lsp-lite] ${warning}`);
    }
    return applied.change;
  }

  function reloadConfig(cwd: string): Promise<ConfigChange> {
    const operation = reloadTail.then(() => reloadConfigNow(cwd));
    reloadTail = operation.catch(() => {});
    return operation;
  }

  async function currentServerStates() {
    return buildServerStates({
      builtins: builtinLanguages,
      active: servers,
      globalConfig: await readGlobalConfig(),
      running: manager.status(),
      installRegistry,
      resolveCommand: which,
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    workingMessageController?.reset();
    workingMessageController = ctx.hasUI
      ? createWorkingMessageController((message) =>
        ctx.ui.setWorkingMessage(message)
      )
      : null;
    validationProgressHandler = workingMessageController?.handle ?? null;

    await reloadConfig(ctx.cwd);
    configWatcher?.close();
    configWatcher = watchConfigFiles({
      cwd: ctx.cwd,
      onChange: async () => {
        const change = await reloadConfig(ctx.cwd);
        if (change.changed && ctx.hasUI) {
          ctx.ui.notify(formatConfigChange(change), "info");
        }
      },
      onError: (error) => console.error("[pi-lsp-lite] config watcher:", error),
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      try {
        const snapshot = await captureBashChangeSnapshot(manager);
        if (snapshot) pendingBashSnapshots.set(event.toolCallId, snapshot);
      } catch (error) {
        if (ctx.signal?.aborted || isAbortError(error)) return;
        console.error("[pi-lsp-lite]", error);
      }
      return;
    }

    if (event.toolName !== "write") return;

    const rawPath = event.input?.path;
    if (typeof rawPath !== "string") return;
    const filePath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
    const absolutePath = resolve(ctx.cwd, filePath);
    if (!isInsideCwd(absolutePath, ctx.cwd)) return;

    try {
      await lstat(absolutePath);
      pendingNewFiles.set(event.toolCallId, false);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        pendingNewFiles.set(event.toolCallId, true);
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash") {
      const before = pendingBashSnapshots.get(event.toolCallId);
      pendingBashSnapshots.delete(event.toolCallId);
      if (!before) return;

      try {
        const { validations } = await resyncAfterBash({
          before,
          manager,
          servers,
          cwd: ctx.cwd,
          signal: ctx.signal,
        });
        const prepared = prepareBashDiagnostics({
          validations,
          cwd: ctx.cwd,
          sendMessage: (message, options) => pi.sendMessage(message, options),
          signal: ctx.signal,
        });
        for (const delivery of prepared.lateDeliveries) {
          monitorLateDelivery(delivery, ctx.signal);
        }
        if (!prepared.content) return;

        if (ctx.hasUI) ctx.ui.notify(prepared.content.trim(), "warning");
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: prepared.content },
          ],
        };
      } catch (error) {
        if (ctx.signal?.aborted || isAbortError(error)) return;
        console.error("[pi-lsp-lite]", error);
      }
      return;
    }

    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const isNewFile = event.toolName === "write" && pendingNewFiles.get(event.toolCallId) === true;
    if (event.toolName === "write") pendingNewFiles.delete(event.toolCallId);

    const rawPath = event.input?.path;
    const inputPath = typeof rawPath === "string" ? rawPath : undefined;
    if (!inputPath) return;
    if (event.isError) return;
    const filePath = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;

    let absolutePath: string;
    try {
      absolutePath = await realpath(resolve(ctx.cwd, filePath));
    } catch {
      return;
    }
    if (!isInsideCwd(absolutePath, ctx.cwd)) return;
    const langConfig = languageForFile(absolutePath, servers);
    if (!langConfig) return;

    try {
      const outcome = await manager.handleEdit(absolutePath, langConfig, ctx.cwd, {
        isNewFile,
        signal: ctx.signal,
      });
      if (outcome.superseded) return;
      monitorLateDelivery(
        deliverLateDiagnostics({
          cwd: ctx.cwd,
          filePath,
          outcome,
          sendMessage: (message, options) => pi.sendMessage(message, options),
          signal: ctx.signal,
        }),
        ctx.signal,
      );
      const result = outcome.initial;
      const formatted = formatDiagnostics(filePath, result, ctx.cwd, result.documentContent);
      if (!formatted) return;

      ctx.ui.notify(formatted.trim(), "warning");

      return {
        content: [...event.content, { type: "text" as const, text: formatted }],
      };
    } catch (err) {
      if (ctx.signal?.aborted || isAbortError(err)) return;
      console.error("[pi-lsp-lite]", err);
    }
  });

  pi.on("user_bash", async (_event, ctx) => {
    let before: BashChangeSnapshot | null;
    try {
      before = await captureBashChangeSnapshot(manager);
    } catch (error) {
      if (ctx.signal?.aborted || isAbortError(error)) return;
      console.error("[pi-lsp-lite]", error);
      return;
    }
    if (!before) return;

    const local = createLocalBashOperations();
    return {
      operations: {
        async exec(command, cwd, options) {
          const result = await local.exec(command, cwd, options);
          try {
            const prepared = await queueDiagnosticsAfterBash({
              before,
              manager,
              servers,
              cwd,
              sendMessage: (message, sendOptions) =>
                pi.sendMessage(message, sendOptions),
              signal: options.signal,
            });
            for (const delivery of prepared.lateDeliveries) {
              monitorLateDelivery(delivery, options.signal);
            }
          } catch (error) {
            if (options.signal?.aborted || isAbortError(error)) return result;
            console.error("[pi-lsp-lite]", error);
          }
          return result;
        },
      },
    };
  });

  pi.on("session_shutdown", async () => {
    configWatcher?.close();
    configWatcher = null;
    validationProgressHandler = null;
    workingMessageController?.reset();
    workingMessageController = null;
    pendingNewFiles.clear();
    pendingBashSnapshots.clear();
    await reloadTail;
    await manager.shutdownAll();
    currentConfig = null;
    servers = [];
  });

  pi.registerCommand("lsp-reload", {
    description: "Reload LSP configuration",
    handler: async (_args, ctx) => {
      const change = await reloadConfig(ctx.cwd);
      ctx.ui.notify(formatConfigChange(change), "info");
    },
  });

  pi.registerCommand("lsp-status", {
    description: "Show configured LSP servers, install state, and running processes",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatServerStates(await currentServerStates()), "info");
    },
  });

  pi.registerCommand("lsp-diag", {
    description: "Show current LSP diagnostics for all tracked files (or a specific file)",
    handler: async (args, ctx) => {
      const allDiags = manager.getAllDiagnostics();

      if (allDiags.size === 0) {
        ctx.ui.notify("pi-lsp-lite: no diagnostics", "info");
        return;
      }

      const filterPath = args?.trim();
      let filterUri: string | undefined;
      if (filterPath) {
        const abs = resolve(ctx.cwd, filterPath);
        filterUri = fileUri(abs);
      }

      const lines: string[] = [];
      for (const [uri, diags] of allDiags) {
        if (filterUri && uri !== filterUri) continue;
        const filePath = fileURLToPath(new URL(uri));
        const relevant = diags.filter((d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning);
        if (relevant.length === 0) continue;
        lines.push(`${filePath} (${relevant.length} diagnostic${relevant.length !== 1 ? "s" : ""})`);
        for (const diagnostic of relevant) {
          lines.push(...formatDiagnostic(filePath, diagnostic, ctx.cwd));
        }
      }

      if (lines.length === 0) {
        ctx.ui.notify(filterPath ? `pi-lsp-lite: no diagnostics for ${filterPath}` : "pi-lsp-lite: no diagnostics", "info");
        return;
      }

      ctx.ui.notify(lines.join("\n"), "warning");
    },
  });

  pi.registerCommand("lsp-add", {
    description: "Add a new language server to global config",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-add requires interactive mode", "error");
        return;
      }

      const rawId = await ctx.ui.input("Server ID (e.g. haskell):");
      if (!rawId) return;
      const id = rawId.trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(id)) {
        ctx.ui.notify("pi-lsp-lite: server ID must be lowercase alphanumeric, hyphens, or underscores", "error");
        return;
      }
      const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
      if (RESERVED_IDS.has(id)) {
        ctx.ui.notify("pi-lsp-lite: reserved ID, choose a different name", "error");
        return;
      }

      const rawCommand = await ctx.ui.input("Binary command (e.g. haskell-language-server-wrapper):");
      const command = rawCommand?.trim();
      if (!command) return;

      const argsRaw = await ctx.ui.input("CLI args (comma-separated, or empty):");
      const args = argsRaw ? argsRaw.split(",").map((a) => a.trim()).filter(Boolean) : [];

      const extRaw = await ctx.ui.input("File extensions (comma-separated, e.g. .hs,.lhs):");
      if (!extRaw) return;
      const extensions = extRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (extensions.length === 0) {
        ctx.ui.notify("pi-lsp-lite: at least one extension is required", "error");
        return;
      }

      const rootRaw = await ctx.ui.input("Root pattern files (comma-separated, or empty):");
      const rootPatterns = rootRaw ? rootRaw.split(",").map((r) => r.trim()).filter(Boolean) : [];

      const resolved = await which(command);
      await writeGlobalConfig({ servers: { [id]: { command, args, extensions, rootPatterns } } });
      await reloadConfig(ctx.cwd);

      if (!resolved) {
        ctx.ui.notify(`pi-lsp-lite: configured server "${id}", but "${command}" is missing from PATH — install it manually before use`, "warning");
        return;
      }
      ctx.ui.notify(`pi-lsp-lite: configured server "${id}" (${resolved})`, "info");
    },
  });

  pi.registerCommand("lsp-remove", {
    description: "Disable a language server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-remove requires interactive mode", "error");
        return;
      }

      if (servers.length === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers configured", "info");
        return;
      }

      const ids = servers.map((s) => s.id);
      const selected = await ctx.ui.select("Disable which server?", ids);
      if (!selected) return;

      const confirmed = await ctx.ui.confirm("Confirm disable", `Disable server "${selected}"?`);
      if (!confirmed) return;

      await writeGlobalConfig({ servers: { [selected]: { disabled: true } } });
      await reloadConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: disabled server "${selected}"`, "info");
    },
  });

  pi.registerCommand("lsp-toggle", {
    description: "Enable or disable a language server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-toggle requires interactive mode", "error");
        return;
      }

      const builtinIds = new Set(builtinLanguages.map((l) => l.id));
      const activeIds = new Set(servers.map((s) => s.id));

      // include disabled user-added servers from global config so they can be re-enabled
      const globalConfig = await readGlobalConfig();
      const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
      const globalServerIds = (globalConfig?.servers && typeof globalConfig.servers === "object" && !Array.isArray(globalConfig.servers))
        ? Object.keys(globalConfig.servers).filter((k) => !RESERVED.has(k))
        : [];
      const allIds = new Set<string>([...builtinIds, ...activeIds, ...globalServerIds]);

      if (allIds.size === 0) {
        ctx.ui.notify("pi-lsp-lite: no servers configured", "info");
        return;
      }

      const entries = [...allIds];
      const options = entries.map((id) => `${id} ${activeIds.has(id) ? "[enabled]" : "[disabled]"}`);
      const choice = await ctx.ui.select("Toggle which server?", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      const id = entries[idx];
      const isCurrentlyEnabled = activeIds.has(id);

      if (isCurrentlyEnabled) {
        await writeGlobalConfig({ servers: { [id]: { disabled: true } } });
      } else {
        // re-enable: works for both built-ins and user-added servers in global config
        await writeGlobalConfig({ servers: { [id]: { disabled: false } } });
      }

      await reloadConfig(ctx.cwd);

      if (isCurrentlyEnabled) {
        ctx.ui.notify(`pi-lsp-lite: disabled server "${id}"`, "info");
        return;
      }

      const state = (await currentServerStates()).find((s) => s.id === id);
      if (state?.installed === false) {
        const installHint = state.installable ? "run /lsp-install" : "install it manually";
        ctx.ui.notify(`pi-lsp-lite: enabled server "${id}", but "${state.command}" is missing from PATH — ${installHint} before use`, "warning");
        return;
      }
      if (state?.installed === null) {
        ctx.ui.notify(`pi-lsp-lite: enabled server "${id}", but its command is incomplete — check global config`, "warning");
        return;
      }
      ctx.ui.notify(`pi-lsp-lite: enabled server "${id}"`, "info");
    },
  });

  pi.registerCommand("lsp-install", {
    description: "Install a missing language server binary",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("pi-lsp-lite: /lsp-install requires interactive mode", "error");
        return;
      }

      const checks = await Promise.all(
        [...installRegistry].map(async ([id, entry]) => {
          const lang = builtinLanguages.find((l) => l.id === id);
          const binary = lang?.command ?? id;
          const found = await which(binary);
          return found ? null : { id, command: binary, installCmd: installCommandFor(entry), description: entry.description };
        }),
      );
      const missing = checks.filter((c): c is NonNullable<typeof c> => c !== null);

      if (missing.length === 0) {
        ctx.ui.notify("pi-lsp-lite: all built-in installable servers are available; custom servers must be installed manually", "info");
        return;
      }

      const options = missing.map((m) => `${m.id} — ${m.description} (${m.command})`);
      const choice = await ctx.ui.select("Install which server?", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      const selected = missing[idx];

      const confirmed = await ctx.ui.confirm("Confirm install", `Run: ${selected.installCmd}`);
      if (!confirmed) return;

      const result = process.platform === "win32"
        ? await pi.exec(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", selected.installCmd])
        : await pi.exec("sh", ["-c", selected.installCmd]);
      if (result.code !== 0) {
        ctx.ui.notify(`pi-lsp-lite: install failed (exit ${result.code})\n${result.stderr}`, "error");
        return;
      }

      await reloadConfig(ctx.cwd);
      ctx.ui.notify(`pi-lsp-lite: installed ${selected.id}`, "info");
    },
  });
}
