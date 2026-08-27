import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedConfig } from "../src/config.js";
import {
  applyResolvedConfig,
  compareResolvedConfigs,
  formatConfigChange,
} from "../src/config-reload.js";

function resolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: [{
      id: "go",
      extensions: [".go"],
      command: "gopls",
      args: ["serve"],
      rootPatterns: ["go.mod"],
    }],
    diagnosticTimeout: 5_000,
    documentIdleTimeout: 120_000,
    perServerTimeout: new Map(),
    softDeadline: 10_000,
    ...overrides,
  };
}

function fakeManager() {
  return {
    shutdowns: 0,
    async shutdownAll() {
      this.shutdowns += 1;
    },
  };
}

describe("config reload", () => {
  it("keeps the manager after a no-op config edit", async () => {
    const manager = fakeManager();
    const previous = resolvedConfig();
    const next = resolvedConfig({ perServerTimeout: new Map() });
    let creations = 0;

    const result = await applyResolvedConfig(
      { config: previous, manager },
      next,
      () => {
        creations += 1;
        return fakeManager();
      },
    );

    assert.equal(result.change.changed, false);
    assert.equal(result.runtime.manager, manager);
    assert.equal(manager.shutdowns, 0);
    assert.equal(creations, 0);
    assert.equal(formatConfigChange(result.change), "pi-lsp-lite: config unchanged");
  });

  it("reports an added server and replaces the manager", async () => {
    const manager = fakeManager();
    const previous = resolvedConfig();
    const next = resolvedConfig({
      servers: [
        ...previous.servers,
        {
          id: "haskell",
          extensions: [".hs"],
          command: "haskell-language-server-wrapper",
          args: ["--lsp"],
          rootPatterns: ["cabal.project"],
        },
      ],
    });
    const replacement = fakeManager();

    const result = await applyResolvedConfig(
      { config: previous, manager },
      next,
      () => replacement,
    );

    assert.deepEqual(result.change, {
      changed: true,
      added: ["haskell"],
      removed: [],
      retuned: [],
    });
    assert.equal(manager.shutdowns, 1);
    assert.equal(result.runtime.manager, replacement);
    assert.equal(result.runtime.config, next);
    assert.equal(
      formatConfigChange(result.change),
      "pi-lsp-lite: config reloaded (1 added)",
    );
  });

  it("reports existing servers as retuned when a timeout changes", () => {
    const previous = resolvedConfig();
    const next = resolvedConfig({ diagnosticTimeout: 8_000 });

    assert.deepEqual(compareResolvedConfigs(previous, next), {
      changed: true,
      added: [],
      removed: [],
      retuned: ["go"],
    });
  });

  it("compares map and object keys in stable order", () => {
    const previous = resolvedConfig({
      perServerTimeout: new Map([["rust", 30_000], ["go", 5_000]]),
      servers: [{
        id: "go",
        extensions: [".go"],
        command: "gopls",
        args: ["serve"],
        rootPatterns: ["go.mod"],
        languageIds: { ".tmpl": "gotmpl", ".go": "go" },
      }],
    });
    const next = resolvedConfig({
      perServerTimeout: new Map([["go", 5_000], ["rust", 30_000]]),
      servers: [{
        id: "go",
        extensions: [".go"],
        command: "gopls",
        args: ["serve"],
        rootPatterns: ["go.mod"],
        languageIds: { ".go": "go", ".tmpl": "gotmpl" },
      }],
    });

    assert.equal(compareResolvedConfigs(previous, next).changed, false);
  });
});
