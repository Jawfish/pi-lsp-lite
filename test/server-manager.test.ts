import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { classifyDiagnostics, createServerManager } from "../src/server-manager.js";
import type { LanguageServerConfig } from "../src/languages.js";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { handleInitial } from "./server-manager-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeServerPath = join(__dirname, "fake-server.ts");

const projectRoot = join(__dirname, "..");
const tsxPath = join(projectRoot, "node_modules", ".bin", "tsx");

const fakeConfig: LanguageServerConfig = {
  id: "fake",
  extensions: [".go"],
  command: tsxPath,
  args: [fakeServerPath, "--run"],
  rootPatterns: ["go.mod"],
};

const missingConfig: LanguageServerConfig = {
  id: "missing",
  extensions: [".xyz"],
  command: "nonexistent-lsp-server-binary-42",
  args: [],
  rootPatterns: [],
};

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `pi-lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

function makeDiagnostic(message: string, line = 0): Diagnostic {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 5 },
    },
    severity: DiagnosticSeverity.Error,
    message,
    source: "fake",
    code: "FAKE1001",
  };
}

async function waitForServerStart(
  manager: ReturnType<typeof createServerManager>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (manager.status().length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(manager.status().length > 0, "server should start");
}

describe("Diagnostic delta", () => {
  it("classifies duplicate fingerprints with multiset semantics", () => {
    const duplicate = makeDiagnostic("duplicate");

    const identical = classifyDiagnostics(
      [duplicate, duplicate],
      [{ ...duplicate }, { ...duplicate }],
    );
    assert.equal(identical.hasBaseline, true);
    if (!identical.hasBaseline) return;
    assert.deepEqual(
      identical.diagnostics.map(({ classification }) => classification),
      ["pre-existing", "pre-existing"],
    );
    assert.equal(identical.fixedCount, 0);

    const added = classifyDiagnostics([duplicate], [duplicate, { ...duplicate }]);
    assert.equal(added.hasBaseline, true);
    if (!added.hasBaseline) return;
    assert.deepEqual(
      added.diagnostics.map(({ classification }) => classification),
      ["pre-existing", "new"],
    );
    assert.equal(added.fixedCount, 0);

    const removed = classifyDiagnostics([duplicate, duplicate], [duplicate]);
    assert.equal(removed.hasBaseline, true);
    if (!removed.hasBaseline) return;
    assert.deepEqual(
      removed.diagnostics.map(({ classification }) => classification),
      ["pre-existing"],
    );
    assert.equal(removed.fixedCount, 1);
  });

  it("ignores diagnostic positions in fingerprints", () => {
    const baseline = makeDiagnostic("moved", 1);
    const moved = makeDiagnostic("moved", 20);
    const delta = classifyDiagnostics([baseline], [moved]);

    assert.equal(delta.hasBaseline, true);
    if (!delta.hasBaseline) return;
    assert.equal(delta.diagnostics[0]?.classification, "pre-existing");
    assert.equal(delta.fixedCount, 0);
  });
});

describe("ServerManager", () => {
  it("first edit spawns server, second reuses it", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result1 = await handleInitial(manager, filePath, fakeConfig, dir);
    assert.equal(result1.status, "ok");
    assert.equal(result1.documentContent, "package main");

    const status1 = manager.status();
    assert.equal(status1.length, 1);

    await writeFile(filePath, "package main\n");
    const result2 = await handleInitial(manager, filePath, fakeConfig, dir);
    assert.equal(result2.status, "ok");
    assert.equal(result2.documentContent, "package main\n");

    const status2 = manager.status();
    assert.equal(status2.length, 1);
    assert.equal(status2[0].pid, status1[0].pid);

    await manager.shutdownAll();
  });

  it("skips the first baseline and uses zero for a newly created file", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const existingPath = join(dir, "existing.go");
    const newPath = join(dir, "new.go");
    await writeFile(existingPath, "package main");
    await writeFile(newPath, "package main");

    const first = await handleInitial(manager, existingPath, fakeConfig, dir);
    assert.deepEqual(first.delta, { hasBaseline: false });

    const second = await handleInitial(manager, existingPath, fakeConfig, dir);
    assert.equal(second.delta.hasBaseline, true);
    if (second.delta.hasBaseline) {
      assert.equal(second.delta.diagnostics[0]?.classification, "pre-existing");
      assert.equal(second.delta.fixedCount, 0);
    }

    const created = await handleInitial(manager, newPath, fakeConfig, dir, {
      isNewFile: true,
    });
    assert.equal(created.delta.hasBaseline, true);
    if (created.delta.hasBaseline) {
      assert.equal(created.delta.diagnostics[0]?.classification, "new");
      assert.equal(created.delta.fixedCount, 0);
    }

    await manager.shutdownAll();
  });

  it("concurrent first edits don't spawn duplicate servers", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const file1 = join(dir, "a.go");
    const file2 = join(dir, "b.go");
    await writeFile(file1, "package main");
    await writeFile(file2, "package main");

    const [r1, r2] = await Promise.all([
      handleInitial(manager, file1, fakeConfig, dir),
      handleInitial(manager, file2, fakeConfig, dir),
    ]);

    assert.equal(r1.status, "ok");
    assert.equal(r2.status, "ok");

    const status = manager.status();
    assert.equal(status.length, 1);

    await manager.shutdownAll();
  });

  it("missing binary disables language permanently", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    const filePath = join(dir, "main.xyz");
    await writeFile(filePath, "content");

    const result1 = await handleInitial(manager, filePath, missingConfig, dir);
    assert.equal(result1.status, "unavailable");
    assert.equal(result1.diagnostics.length, 0);

    const result2 = await handleInitial(manager, filePath, missingConfig, dir);
    assert.equal(result2.status, "unavailable");
    assert.equal(result2.diagnostics.length, 0);

    assert.equal(manager.status().length, 0);

    await manager.shutdownAll();
  });

  it("different workspace roots get different servers", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();

    const mod1 = join(dir, "mod1");
    const mod2 = join(dir, "mod2");
    await mkdir(mod1, { recursive: true });
    await mkdir(mod2, { recursive: true });

    await writeFile(join(mod1, "go.mod"), "module mod1");
    await writeFile(join(mod2, "go.mod"), "module mod2");

    const file1 = join(mod1, "main.go");
    const file2 = join(mod2, "main.go");
    await writeFile(file1, "package main");
    await writeFile(file2, "package main");

    await handleInitial(manager, file1, fakeConfig, dir);
    await handleInitial(manager, file2, fakeConfig, dir);

    const status = manager.status();
    assert.equal(status.length, 2);

    await manager.shutdownAll();
  });

  it("init failure in one root does not prevent another root from starting", async () => {
    const crashConfig: LanguageServerConfig = {
      id: "fake-crash",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"crashOnInit":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager();
    const dir = await makeTempDir();

    const rootA = join(dir, "root-a");
    const rootB = join(dir, "root-b");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(join(rootA, "go.mod"), "module a");
    await writeFile(join(rootB, "go.mod"), "module b");

    const fileA = join(rootA, "main.go");
    const fileB = join(rootB, "main.go");
    await writeFile(fileA, "package main");
    await writeFile(fileB, "package main");

    // root A crashes on init; its failure can finish just after the soft deadline
    const outcomeA = await manager.handleEdit(fileA, crashConfig, dir);
    const resultA = (await outcomeA.pending) ?? outcomeA.initial;
    assert.equal(resultA.status, "unavailable");
    assert.equal(resultA.diagnostics.length, 0);

    // root B should still work with a working config
    const resultB = await handleInitial(manager, fileB, fakeConfig, dir);
    assert.equal(resultB.status, "ok");
    assert.ok(resultB.diagnostics.length > 0, "root B should produce diagnostics");

    await manager.shutdownAll();
  });

  it("shutdownAll kills all servers", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    await handleInitial(manager, filePath, fakeConfig, dir);
    assert.equal(manager.status().length, 1);

    await manager.shutdownAll();
    assert.equal(manager.status().length, 0);
  });

  it("shutdownAll completes when server never responds to shutdown", async () => {
    const neverShutdownConfig: LanguageServerConfig = {
      id: "fake-hang",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverShutdown":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    await handleInitial(manager, filePath, neverShutdownConfig, dir);
    assert.equal(manager.status().length, 1);

    const start = Date.now();
    await manager.shutdownAll();
    const elapsed = Date.now() - start;

    assert.equal(manager.status().length, 0);
    assert.ok(elapsed < 15_000, `shutdownAll took ${elapsed}ms, expected < 15s`);
  });
});

describe("Abort handling", () => {
  it("rejects a pre-aborted edit without starting a server", async () => {
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      handleInitial(manager, filePath, fakeConfig, dir, { signal: controller.signal }),
      (error: Error) => error.name === "AbortError",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.status().length, 0);

    await manager.shutdownAll();
  });

  it("aborts retry backoff and skips remaining attempts", async () => {
    const retryConfig: LanguageServerConfig = {
      id: "fake-abort-retry",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"publishOnAttempt":2}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 100, maxRetries: 3 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");
    const controller = new AbortController();

    const pending = handleInitial(manager, filePath, retryConfig, dir, {
      signal: controller.signal,
    });
    await waitForServerStart(manager);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const abortTime = Date.now();
    controller.abort();

    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
    assert.ok(Date.now() - abortTime < 250, "backoff should abort promptly");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(manager.getAllDiagnostics().size, 0, "abort should prevent the retry");

    await manager.shutdownAll();
  });

  it("caller abort cancels an unshared server startup", async () => {
    const slowInitConfig: LanguageServerConfig = {
      id: "fake-abort-caller-init",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"initializeDelay":2000}'],
      rootPatterns: ["go.mod"],
    };
    const recoveredConfig: LanguageServerConfig = {
      ...slowInitConfig,
      args: [fakeServerPath, "--run"],
    };
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");
    const controller = new AbortController();

    const pending = handleInitial(manager, filePath, slowInitConfig, dir, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(manager.status().length, 0);

    const recovered = await handleInitial(manager, filePath, recoveredConfig, dir);
    assert.equal(recovered.status, "ok");
    await manager.shutdownAll();
  });

  it("shutdown drains a server that is still initializing", async () => {
    const slowInitConfig: LanguageServerConfig = {
      id: "fake-abort-init",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"initializeDelay":2000}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager();
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const pending = handleInitial(manager, filePath, slowInitConfig, dir);
    const rejection = assert.rejects(
      pending,
      (error: Error) => error.name === "AbortError",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await manager.shutdownAll();
    await rejection;
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(manager.status().length, 0);
  });

  it("shutdown aborts validation before server teardown", async () => {
    const neverPublishConfig: LanguageServerConfig = {
      id: "fake-abort-shutdown",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverPublish":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 10_000 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const pending = handleInitial(manager, filePath, neverPublishConfig, dir);
    const rejection = assert.rejects(
      pending,
      (error: Error) => error.name === "AbortError",
    );
    await waitForServerStart(manager);
    const start = Date.now();
    await manager.shutdownAll();
    await rejection;

    assert.ok(Date.now() - start < 1_000, "shutdown should not wait for diagnostics");
    assert.equal(manager.status().length, 0);
  });
});

describe("Soft deadline", () => {
  it("returns an initial result before a cold slow server completes", async () => {
    const slowConfig: LanguageServerConfig = {
      id: "fake-soft-deadline",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"initializeDelay":750}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({
      diagnosticTimeout: 2_000,
      maxRetries: 0,
      softDeadline: 100,
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const start = Date.now();
    const outcome = await manager.handleEdit(filePath, slowConfig, dir);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 400, `initial result took ${elapsed}ms`);
    assert.equal(outcome.initial.status, "timeout");
    assert.ok(outcome.pending);
    const final = await outcome.pending;
    assert.equal(final?.status, "ok");
    assert.equal(final?.diagnostics[0]?.message, "fake error");

    await manager.shutdownAll();
  });

  it("resolves pending to null when the initial result is complete", async () => {
    const manager = createServerManager({ softDeadline: 2_000 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const outcome = await manager.handleEdit(filePath, fakeConfig, dir);

    assert.equal(outcome.initial.status, "ok");
    assert.ok(outcome.pending);
    assert.equal(await outcome.pending, null);

    await manager.shutdownAll();
  });

  it("keeps full background validations serialized per server", async () => {
    const slowConfig: LanguageServerConfig = {
      id: "fake-soft-queue",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"diagnosticDelay":300}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({
      diagnosticTimeout: 2_000,
      maxRetries: 0,
      softDeadline: 50,
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const warmPath = join(dir, "warm.go");
    const firstPath = join(dir, "first.go");
    const secondPath = join(dir, "second.go");
    await writeFile(warmPath, "package main");
    await writeFile(firstPath, "package main");
    await writeFile(secondPath, "package main");

    const warm = await manager.handleEdit(warmPath, slowConfig, dir);
    assert.ok(warm.pending);
    await warm.pending;

    const first = await manager.handleEdit(firstPath, slowConfig, dir);
    const secondStart = Date.now();
    const second = await manager.handleEdit(secondPath, slowConfig, dir);
    const secondInitialElapsed = Date.now() - secondStart;
    assert.equal(first.initial.status, "timeout");
    assert.equal(second.initial.status, "timeout");
    assert.ok(
      secondInitialElapsed < 200,
      `queued initial result took ${secondInitialElapsed}ms`,
    );
    assert.ok(first.pending);
    assert.ok(second.pending);

    let firstFinished = 0;
    let secondFinished = 0;
    const [firstFinal, secondFinal] = await Promise.all([
      first.pending.then((result) => {
        firstFinished = Date.now();
        return result;
      }),
      second.pending.then((result) => {
        secondFinished = Date.now();
        return result;
      }),
    ]);

    assert.equal(firstFinal?.status, "ok");
    assert.equal(secondFinal?.status, "ok");
    assert.ok(
      Math.abs(secondFinished - firstFinished) >= 300,
      "background validations should finish serially",
    );

    await manager.shutdownAll();
  });

  it("continues retries on the pending promise", async () => {
    const retryConfig: LanguageServerConfig = {
      id: "fake-soft-retry",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"publishOnAttempt":2}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({
      diagnosticTimeout: 100,
      maxRetries: 1,
      softDeadline: 50,
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const outcome = await manager.handleEdit(filePath, retryConfig, dir);
    assert.equal(outcome.initial.status, "timeout");
    assert.ok(outcome.pending);
    const final = await outcome.pending;
    assert.equal(final?.status, "ok");
    assert.equal(final?.retryAttempts, 1);

    await manager.shutdownAll();
  });

  it("keeps abort rejection on pending validation", async () => {
    const neverPublishConfig: LanguageServerConfig = {
      id: "fake-soft-abort",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverPublish":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({
      diagnosticTimeout: 10_000,
      softDeadline: 50,
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");
    const controller = new AbortController();

    const outcome = await manager.handleEdit(filePath, neverPublishConfig, dir, {
      signal: controller.signal,
    });
    assert.ok(outcome.pending);
    const rejection = assert.rejects(
      outcome.pending,
      (error: Error) => error.name === "AbortError",
    );
    controller.abort();
    await rejection;

    await manager.shutdownAll();
  });
});

describe("ServerManagerOptions", () => {
  it("diagnosticTimeout: short timeout causes timeout result when server is slow", async () => {
    const slowConfig: LanguageServerConfig = {
      id: "fake-slow",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"diagnosticDelay":2000}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 200, maxRetries: 0 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await handleInitial(manager, filePath, slowConfig, dir);
    assert.equal(result.status, "timeout");

    await manager.shutdownAll();
  });

  it("perServerTimeout overrides global diagnosticTimeout for the named server", async () => {
    const slowConfig: LanguageServerConfig = {
      id: "fake-slow2",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"diagnosticDelay":2000}'],
      rootPatterns: ["go.mod"],
    };
    // global timeout is generous, but per-server timeout for fake-slow2 is very short
    const manager = createServerManager({
      diagnosticTimeout: 10_000,
      perServerTimeout: new Map([["fake-slow2", 200]]),
      maxRetries: 0,
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await handleInitial(manager, filePath, slowConfig, dir);
    assert.equal(result.status, "timeout");

    await manager.shutdownAll();
  });

  it("perServerTimeout does not affect other servers", async () => {
    // fake server (id=fake) responds promptly; perServerTimeout only targets another id
    const manager = createServerManager({
      diagnosticTimeout: 5_000,
      perServerTimeout: new Map([["unrelated", 1]]),
    });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await handleInitial(manager, filePath, fakeConfig, dir);
    assert.equal(result.status, "ok");

    await manager.shutdownAll();
  });
});

describe("Retry logic", () => {
  it("no retry when server publishes diagnostics on first attempt", async () => {
    const manager = createServerManager({ diagnosticTimeout: 2_000 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await handleInitial(manager, filePath, fakeConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.retryAttempts, 0);
    assert.ok(result.diagnostics.length > 0);

    await manager.shutdownAll();
  });

  it("retries and succeeds when server publishes on 3rd attempt", async () => {
    const publish3rdConfig: LanguageServerConfig = {
      id: "fake-publish3rd",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"publishOnAttempt":3}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 500 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await handleInitial(manager, filePath, publish3rdConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.retryAttempts, 2);
    assert.ok(result.diagnostics.length > 0);

    await manager.shutdownAll();
  });

  it("does not retry when a push server omits an update after validation", async () => {
    const publishOnceConfig: LanguageServerConfig = {
      id: "fake-publish-once",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"publishOnlyOnce":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 100, maxRetries: 3 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const first = await handleInitial(manager, filePath, publishOnceConfig, dir);
    assert.equal(first.status, "ok");

    await writeFile(filePath, "package main\n");
    const start = Date.now();
    const second = await handleInitial(manager, filePath, publishOnceConfig, dir);
    const elapsed = Date.now() - start;

    assert.equal(second.status, "timeout");
    assert.equal(second.retryable, false);
    assert.equal(second.retryAttempts, 0);
    assert.ok(elapsed < 1_000, `should not have retried, took ${elapsed}ms`);

    await manager.shutdownAll();
  });

  it("keeps cross-file diagnostics found before a pull retry", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    const stalledPath = join(dir, "stalled.go");
    const relatedPath = join(dir, "related.go");
    await writeFile(filePath, "package main");
    await writeFile(stalledPath, "package main");
    await writeFile(relatedPath, "package main");

    const stalledUri = pathToFileURL(stalledPath).href;
    const relatedUri = pathToFileURL(relatedPath).href;
    const options = JSON.stringify({
      neverPullUris: [stalledUri],
      otherFileDiagnostics: {
        [relatedUri]: [
          {
            message: "related error",
            range: {
              end: { character: 5, line: 0 },
              start: { character: 0, line: 0 },
            },
            severity: 1,
          },
        ],
      },
      pullDiagnostics: true,
    });
    const pullConfig: LanguageServerConfig = {
      id: "fake-pull-retry",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", `--options=${options}`],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 100, maxRetries: 1 });

    await handleInitial(manager, stalledPath, pullConfig, dir);
    const result = await handleInitial(manager, filePath, pullConfig, dir);

    assert.equal(result.status, "timeout");
    assert.equal(result.retryAttempts, 1);
    assert.equal(result.otherFiles[0]?.uri, relatedUri);
    assert.equal(result.otherFiles[0]?.errorCount, 1);

    await manager.shutdownAll();
  });

  it("exhausts maxRetries and returns timeout when server never publishes", async () => {
    const neverPublishConfig: LanguageServerConfig = {
      id: "fake-nopub",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverPublish":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 200, maxRetries: 3 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await handleInitial(manager, filePath, neverPublishConfig, dir);
    assert.equal(result.status, "timeout");
    assert.equal(result.retryAttempts, 3);

    await manager.shutdownAll();
  });

  it("per-server maxRetries on LanguageServerConfig overrides manager default", async () => {
    const publish2ndConfig: LanguageServerConfig = {
      id: "fake-publish2nd",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"publishOnAttempt":2}'],
      rootPatterns: ["go.mod"],
      maxRetries: 1,
    };
    // manager default is 0 — without the per-server override it would not retry
    const manager = createServerManager({ diagnosticTimeout: 300, maxRetries: 0 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const result = await handleInitial(manager, filePath, publish2ndConfig, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.retryAttempts, 1);
    assert.ok(result.diagnostics.length > 0);

    await manager.shutdownAll();
  });

  it("maxRetries: 0 means single attempt only", async () => {
    const neverPublishConfig: LanguageServerConfig = {
      id: "fake-nopub2",
      extensions: [".go"],
      command: tsxPath,
      args: [fakeServerPath, "--run", '--options={"neverPublish":true}'],
      rootPatterns: ["go.mod"],
    };
    const manager = createServerManager({ diagnosticTimeout: 200, maxRetries: 0 });
    const dir = await makeTempDir();
    await writeFile(join(dir, "go.mod"), "module test");
    const filePath = join(dir, "main.go");
    await writeFile(filePath, "package main");

    const start = Date.now();
    const result = await handleInitial(manager, filePath, neverPublishConfig, dir);
    const elapsed = Date.now() - start;

    assert.equal(result.status, "timeout");
    assert.equal(result.retryAttempts, 0);
    assert.ok(elapsed < 2_000, `should not have retried, took ${elapsed}ms`);

    await manager.shutdownAll();
  });
});
