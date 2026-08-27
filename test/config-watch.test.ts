import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchConfigFiles } from "../src/config-watch.js";

class FakeWatcher extends EventEmitter {
  closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

type WatchListener = (eventType: string, filename: string | null) => void;

function fakeWatchHarness() {
  const registrations = new Map<string, Array<{
    listener: WatchListener;
    watcher: FakeWatcher;
  }>>();

  return {
    registrations,
    watchDirectory(directory: string, listener: WatchListener): FakeWatcher {
      const watcher = new FakeWatcher();
      const entries = registrations.get(directory) ?? [];
      entries.push({ listener, watcher });
      registrations.set(directory, entries);
      return watcher;
    },
    emit(directory: string, eventType: string, filename: string | null): void {
      const entries = registrations.get(directory) ?? [];
      const active = [...entries].reverse().find(({ watcher }) => !watcher.closed);
      assert.ok(active, `no active watcher for ${directory}`);
      active.listener(eventType, filename);
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("config file watchers", () => {
  it("routes create, modify, and delete events for all config paths", async () => {
    const harness = fakeWatchHarness();
    let reloads = 0;
    const handle = watchConfigFiles({
      cwd: "/workspace/project",
      globalConfigPath: "/home/test/.pi-lsp-lite.json",
      debounceMs: 5,
      watchDirectory: harness.watchDirectory,
      onChange: () => { reloads += 1; },
    });

    harness.emit("/home/test", "rename", ".pi-lsp-lite.json");
    await delay(10);
    assert.equal(reloads, 1, "global config create should reload");

    harness.emit("/workspace/project", "change", ".pi-lsp-lite.json");
    await delay(10);
    assert.equal(reloads, 2, "project config modification should reload");

    harness.emit("/workspace/project/.pi", "rename", "lsp-lite.json");
    await delay(10);
    assert.equal(reloads, 3, "nested project config delete should reload");

    harness.emit("/workspace/project", "change", "unrelated.json");
    await delay(10);
    assert.equal(reloads, 3, "unrelated files should not reload config");
    handle.close();
  });

  it("debounces a burst of file events", async () => {
    const harness = fakeWatchHarness();
    let reloads = 0;
    const handle = watchConfigFiles({
      cwd: "/workspace/project",
      globalConfigPath: "/home/test/.pi-lsp-lite.json",
      debounceMs: 10,
      watchDirectory: harness.watchDirectory,
      onChange: () => { reloads += 1; },
    });

    harness.emit("/workspace/project", "rename", ".pi-lsp-lite.json");
    harness.emit("/workspace/project", "change", ".pi-lsp-lite.json");
    harness.emit("/workspace/project", "rename", ".pi-lsp-lite.json");
    await delay(20);

    assert.equal(reloads, 1);
    handle.close();
  });

  it("refreshes the nested watcher when the .pi directory changes", async () => {
    const harness = fakeWatchHarness();
    let reloads = 0;
    const handle = watchConfigFiles({
      cwd: "/workspace/project",
      globalConfigPath: "/home/test/.pi-lsp-lite.json",
      debounceMs: 5,
      watchDirectory: harness.watchDirectory,
      onChange: () => { reloads += 1; },
    });
    const original = harness.registrations.get("/workspace/project/.pi")?.[0];
    assert.ok(original);

    harness.emit("/workspace/project", "rename", ".pi");
    await delay(10);

    assert.equal(original.watcher.closed, true);
    assert.equal(harness.registrations.get("/workspace/project/.pi")?.length, 2);
    assert.equal(reloads, 1);
    handle.close();
  });

  it("cancels pending work and closes every watcher", async () => {
    const harness = fakeWatchHarness();
    let reloads = 0;
    const handle = watchConfigFiles({
      cwd: "/workspace/project",
      globalConfigPath: "/home/test/.pi-lsp-lite.json",
      debounceMs: 10,
      watchDirectory: harness.watchDirectory,
      onChange: () => { reloads += 1; },
    });

    harness.emit("/home/test", "change", ".pi-lsp-lite.json");
    handle.close();
    await delay(20);

    assert.equal(reloads, 0);
    for (const entries of harness.registrations.values()) {
      assert.ok(entries.every(({ watcher }) => watcher.closed));
    }
  });
});
