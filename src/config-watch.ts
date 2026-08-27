import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { globalConfigFilePath } from "./config.js";

export interface ConfigWatchHandle {
  close(): void;
}

interface WatcherLike {
  close(): void;
  on(event: "error" | "close", listener: (error?: Error) => void): this;
}

type WatchDirectory = (
  directory: string,
  listener: (eventType: string, filename: string | null) => void,
) => WatcherLike;

export interface ConfigWatchOptions {
  cwd: string;
  onChange: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  globalConfigPath?: string;
  debounceMs?: number;
  watchDirectory?: WatchDirectory;
}

interface WatchEntry {
  names: Set<string>;
  watcher: WatcherLike;
}

const DEFAULT_DEBOUNCE_MS = 300;

function defaultWatchDirectory(
  directory: string,
  listener: (eventType: string, filename: string | null) => void,
): FSWatcher {
  return watch(directory, { encoding: "utf8" }, listener);
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function watchConfigFiles(options: ConfigWatchOptions): ConfigWatchHandle {
  const watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const watchers = new Map<string, WatchEntry>();
  const nestedDirectory = join(options.cwd, ".pi");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function reportError(error: unknown): void {
    if (closed) return;
    if (options.onError) {
      options.onError(error);
      return;
    }
    console.error("[pi-lsp-lite] config watcher:", error);
  }

  function scheduleReload(): void {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void Promise.resolve(options.onChange()).catch(reportError);
    }, debounceMs);
  }

  function removeWatcher(directory: string): void {
    const entry = watchers.get(directory);
    if (!entry) return;
    watchers.delete(directory);
    entry.watcher.close();
  }

  function ensureWatcher(directory: string, names: Iterable<string>): void {
    const existing = watchers.get(directory);
    if (existing) {
      for (const name of names) existing.names.add(name);
      return;
    }

    const watchedNames = new Set(names);
    try {
      const watcher = watchDirectory(directory, (_eventType, filename) => {
        if (closed) return;
        if (filename !== null && !watchedNames.has(filename)) return;

        if (directory === options.cwd && filename === ".pi") {
          removeWatcher(nestedDirectory);
          ensureWatcher(nestedDirectory, ["lsp-lite.json"]);
        }
        scheduleReload();
      });
      const entry: WatchEntry = { names: watchedNames, watcher };
      watchers.set(directory, entry);
      entry.watcher.on("error", (error) => {
        if (watchers.get(directory) !== entry) return;
        watchers.delete(directory);
        entry.watcher.close();
        reportError(error);
      });
      entry.watcher.on("close", () => {
        if (watchers.get(directory) === entry) watchers.delete(directory);
      });
    } catch (error) {
      if (!isMissingDirectory(error)) reportError(error);
    }
  }

  const globalPath = globalConfigFilePath(options.globalConfigPath);
  ensureWatcher(dirname(globalPath), [basename(globalPath)]);
  ensureWatcher(options.cwd, [".pi-lsp-lite.json", ".pi"]);
  ensureWatcher(nestedDirectory, ["lsp-lite.json"]);

  return {
    close() {
      if (closed) return;
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      const entries = [...watchers.values()];
      watchers.clear();
      for (const { watcher } of entries) watcher.close();
    },
  };
}
