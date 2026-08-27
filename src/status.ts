import type { UserConfig } from "./config.js";
import type { InstallEntry } from "./install-registry.js";
import type { LanguageServerConfig } from "./languages.js";
import type { ServerActivity, ServerStatus } from "./server-manager.js";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import { visibleWidth } from "@earendil-works/pi-tui";

export interface ServerState {
  id: string;
  command: string | null;
  enabled: boolean;
  installed: boolean | null;
  installable: boolean;
  running: ServerStatus[];
  starting: string[];
}

export interface BuildServerStatesOptions {
  builtins: LanguageServerConfig[];
  active: LanguageServerConfig[];
  globalConfig: UserConfig | null;
  running: ServerStatus[];
  activity: ServerActivity[];
  installRegistry: Map<string, InstallEntry>;
  resolveCommand(command: string): Promise<string | null>;
}

const RESERVED_SERVER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function globalServerIds(globalConfig: UserConfig | null): string[] {
  const servers = globalConfig?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers).filter((id) => !RESERVED_SERVER_KEYS.has(id));
}

function commandFor(id: string, active: Map<string, LanguageServerConfig>, builtins: Map<string, LanguageServerConfig>, globalConfig: UserConfig | null): string | null {
  const activeConfig = active.get(id);
  if (activeConfig) return activeConfig.command;

  const globalCommand = globalConfig?.servers?.[id]?.command;
  if (typeof globalCommand === "string" && globalCommand.length > 0) return globalCommand;

  const builtin = builtins.get(id);
  return builtin?.command ?? null;
}

export async function buildServerStates(options: BuildServerStatesOptions): Promise<ServerState[]> {
  const active = new Map(options.active.map((server) => [server.id, server]));
  const builtins = new Map(options.builtins.map((server) => [server.id, server]));
  const runningById = new Map<string, ServerStatus[]>();
  const startingById = new Map<string, string[]>();

  for (const status of options.running) {
    const entries = runningById.get(status.id) ?? [];
    entries.push(status);
    runningById.set(status.id, entries);
  }
  for (const status of options.activity) {
    if (status.state !== "starting") continue;
    const roots = startingById.get(status.id) ?? [];
    roots.push(status.root);
    startingById.set(status.id, roots);
  }

  const ids = new Set<string>([
    ...builtins.keys(),
    ...active.keys(),
    ...globalServerIds(options.globalConfig),
  ]);

  const states = await Promise.all([...ids].sort().map(async (id): Promise<ServerState> => {
    const command = commandFor(id, active, builtins, options.globalConfig);
    const installed = command ? (await options.resolveCommand(command)) !== null : null;
    return {
      id,
      command,
      enabled: active.has(id),
      installed,
      installable: options.installRegistry.has(id),
      running: runningById.get(id) ?? [],
      starting: startingById.get(id) ?? [],
    };
  }));

  return states;
}

export function formatStatusLine(
  activity: ServerActivity[],
  diagnostics: ReadonlyMap<string, Diagnostic[]>,
): string | undefined {
  if (activity.length === 0) return undefined;

  const states = new Map<string, ServerActivity["state"]>();
  for (const server of activity) {
    const current = states.get(server.id);
    if (current !== "starting") states.set(server.id, server.state);
  }
  const servers = [...states]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, state]) => `${id}${state === "starting" ? "⏳" : "✓"}`);

  let errors = 0;
  let warnings = 0;
  for (const entries of diagnostics.values()) {
    for (const diagnostic of entries) {
      if (diagnostic.severity === DiagnosticSeverity.Error) errors++;
      if (diagnostic.severity === DiagnosticSeverity.Warning) warnings++;
    }
  }

  return `lsp ${servers.join(" ")} ${errors}E/${warnings}W`;
}

function serverGlyph(state: ServerState): string {
  if (state.starting.length > 0) return "⏳";
  if (state.running.length > 0) return "✓";
  if (state.installed === false) return "✗";
  return "○";
}

function installState(state: ServerState): string {
  const disabled = state.enabled ? "" : " (disabled)";
  if (state.installed === null) return `unknown${disabled}`;
  if (state.installed) return `installed${disabled}`;
  const hint = state.installable ? "/lsp-install" : "manual";
  return `missing (${hint})${disabled}`;
}

function padColumn(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

export function formatServerStates(states: ServerState[]): string {
  if (states.length === 0) return "pi-lsp-lite: no servers configured";

  const rows = states.map((state) => [
    serverGlyph(state),
    state.id,
    state.command ?? "unknown",
    installState(state),
  ]);
  const header = ["STATE", "SERVER", "COMMAND", "INSTALL"];
  const widths = header.map((column, index) =>
    Math.max(
      visibleWidth(column),
      ...rows.map((row) => visibleWidth(row[index])),
    )
  );
  const formatRow = (row: string[]) =>
    row.map((column, index) =>
      index === row.length - 1 ? column : padColumn(column, widths[index])
    ).join("  ");

  const lines = [formatRow(header)];
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    lines.push(formatRow(rows[index]));
    const rootIndent = " ".repeat(widths[0] + 2);
    for (const root of [...state.starting].sort()) {
      lines.push(`${rootIndent}↳ ${root}  starting`);
    }
    for (const running of [...state.running].sort((left, right) =>
      left.root.localeCompare(right.root)
    )) {
      const up = Math.round(running.uptime / 1000);
      lines.push(
        `${rootIndent}↳ ${running.root}  pid=${running.pid}  up=${up}s  open=${running.openDocuments}`,
      );
    }
  }
  lines.push("", "Legend: ✓ running  ○ idle  ✗ missing  ⏳ starting");
  return lines.join("\n");
}
