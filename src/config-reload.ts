import type { ResolvedConfig } from "./config.js";

export interface ConfigChange {
  changed: boolean;
  added: string[];
  removed: string[];
  retuned: string[];
}

export interface ConfigRuntime<TManager> {
  config: ResolvedConfig | null;
  manager: TManager;
}

interface StoppableManager {
  shutdownAll(): Promise<void>;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, item]) => [key, canonicalize(item)]);
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function compareResolvedConfigs(
  previous: ResolvedConfig | null,
  next: ResolvedConfig,
): ConfigChange {
  if (!previous) {
    return {
      changed: true,
      added: next.servers.map((server) => server.id),
      removed: [],
      retuned: [],
    };
  }

  if (stableJson(previous) === stableJson(next)) {
    return { changed: false, added: [], removed: [], retuned: [] };
  }

  const previousServers = new Map(previous.servers.map((server) => [server.id, server]));
  const nextServers = new Map(next.servers.map((server) => [server.id, server]));
  const added = next.servers
    .filter((server) => !previousServers.has(server.id))
    .map((server) => server.id);
  const removed = previous.servers
    .filter((server) => !nextServers.has(server.id))
    .map((server) => server.id);
  const globalTuningChanged =
    previous.diagnosticTimeout !== next.diagnosticTimeout
    || previous.documentIdleTimeout !== next.documentIdleTimeout
    || previous.softDeadline !== next.softDeadline;
  const previousCommonOrder = previous.servers
    .filter(({ id }) => nextServers.has(id))
    .map(({ id }) => id);
  const nextCommonOrder = next.servers
    .filter(({ id }) => previousServers.has(id))
    .map(({ id }) => id);
  const serverOrderChanged = previousCommonOrder.join("\0")
    !== nextCommonOrder.join("\0");
  const retuned = next.servers
    .filter((server) => {
      const oldServer = previousServers.get(server.id);
      if (!oldServer) return false;
      return globalTuningChanged
        || serverOrderChanged
        || stableJson(oldServer) !== stableJson(server)
        || previous.perServerTimeout.get(server.id) !== next.perServerTimeout.get(server.id);
    })
    .map((server) => server.id);

  return { changed: true, added, removed, retuned };
}

export async function applyResolvedConfig<TManager extends StoppableManager>(
  runtime: ConfigRuntime<TManager>,
  next: ResolvedConfig,
  createManager: (config: ResolvedConfig) => TManager,
): Promise<{ runtime: ConfigRuntime<TManager>; change: ConfigChange }> {
  const change = compareResolvedConfigs(runtime.config, next);
  if (!change.changed) return { runtime, change };

  await runtime.manager.shutdownAll();
  return {
    runtime: {
      config: next,
      manager: createManager(next),
    },
    change,
  };
}

export function formatConfigChange(change: ConfigChange): string {
  if (!change.changed) return "pi-lsp-lite: config unchanged";

  const parts: string[] = [];
  if (change.added.length > 0) parts.push(`${change.added.length} added`);
  if (change.removed.length > 0) parts.push(`${change.removed.length} removed`);
  if (change.retuned.length > 0) parts.push(`${change.retuned.length} retuned`);
  if (parts.length === 0) parts.push("settings changed");
  return `pi-lsp-lite: config reloaded (${parts.join(", ")})`;
}
