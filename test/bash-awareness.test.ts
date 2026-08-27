import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import {
  captureBashChangeSnapshot,
  prepareBashDiagnostics,
  resyncAfterBash,
} from "../src/bash-awareness.js";
import { createServerManager } from "../src/server-manager.js";
import type { LanguageServerConfig } from "../src/languages.js";
import type { LspDiagnosticsMessage } from "../src/late-delivery.js";
import { handleFinal } from "./server-manager-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeServerPath = join(__dirname, "fake-server.ts");
const tsxPath = join(__dirname, "..", "node_modules", ".bin", "tsx");

let tempDirs: string[] = [];
let managers: ReturnType<typeof createServerManager>[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `pi-lsp-bash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.shutdownAll()));
  managers = [];
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

function diagnostic(message: string): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 6 },
    },
    severity: DiagnosticSeverity.Error,
    message,
    source: "fake",
  };
}

function fakeConfig(delay = 0): LanguageServerConfig {
  const diagnosticsByText = {
    "clean\n": [],
    "broken\n": [diagnostic("bash error")],
  };
  return {
    id: "fake-bash",
    extensions: [".go"],
    command: tsxPath,
    args: [
      fakeServerPath,
      "--run",
      `--options=${JSON.stringify({ diagnosticDelay: delay, diagnosticsByText })}`,
    ],
    rootPatterns: ["go.mod"],
    maxRetries: 0,
  };
}

async function openCleanDocument(
  manager: ReturnType<typeof createServerManager>,
  config: LanguageServerConfig,
  root: string,
): Promise<string> {
  const filePath = join(root, "main.go");
  await writeFile(join(root, "go.mod"), "module example\n");
  await writeFile(filePath, "clean\n");
  const result = await handleFinal(manager, filePath, config, root);
  assert.equal(result.status, "ok");
  return filePath;
}

describe("bash change awareness", () => {
  it("revalidates changed documents and formats the initial result", async () => {
    const root = await makeTempDir();
    const manager = createServerManager({ maxRetries: 0 });
    managers.push(manager);
    const config = fakeConfig();
    const filePath = await openCleanDocument(manager, config, root);
    const before = await captureBashChangeSnapshot(manager);
    assert.ok(before);

    await writeFile(filePath, "broken\n");
    const result = await resyncAfterBash({
      before,
      manager,
      servers: [config],
      cwd: root,
    });

    assert.equal(result.validations.length, 1);
    assert.equal(result.validations[0]?.outcome.initial.status, "ok");
    assert.equal(
      result.validations[0]?.outcome.initial.diagnostics[0]?.message,
      "bash error",
    );
    assert.equal(
      result.validations[0]?.outcome.initial.documentContent,
      "broken\n",
    );

    const messages: LspDiagnosticsMessage[] = [];
    const prepared = prepareBashDiagnostics({
      validations: result.validations,
      cwd: root,
      sendMessage: (message) => messages.push(message),
    });
    assert.match(prepared.content, /main\.go:1:1: error: bash error/u);
    await Promise.all(prepared.lateDeliveries);
    assert.deepEqual(messages, []);
  });

  it("closes deleted tracked documents and drops their diagnostics", async () => {
    const root = await makeTempDir();
    const manager = createServerManager({ maxRetries: 0 });
    managers.push(manager);
    const config = fakeConfig();
    const filePath = await openCleanDocument(manager, config, root);
    await writeFile(filePath, "broken\n");
    await handleFinal(manager, filePath, config, root);
    assert.equal(manager.getAllDiagnostics().size, 1);
    const before = await captureBashChangeSnapshot(manager);
    assert.ok(before);

    await rm(filePath);
    const result = await resyncAfterBash({
      before,
      manager,
      servers: [config],
      cwd: root,
    });

    assert.deepEqual(result.diff.deleted.map(({ path }) => path), [filePath]);
    assert.deepEqual(result.validations, []);
    assert.equal(manager.snapshotTargets()[0]?.documentUris.length, 0);
    assert.equal(manager.getAllDiagnostics().size, 0);
  });

  it("late-delivers a changed result after the soft deadline", async () => {
    const root = await makeTempDir();
    const manager = createServerManager({
      diagnosticTimeout: 1_000,
      maxRetries: 0,
      softDeadline: 50,
    });
    managers.push(manager);
    const config = fakeConfig(250);
    const filePath = await openCleanDocument(manager, config, root);
    const before = await captureBashChangeSnapshot(manager);
    assert.ok(before);

    await writeFile(filePath, "broken\n");
    const result = await resyncAfterBash({
      before,
      manager,
      servers: [config],
      cwd: root,
    });
    assert.equal(result.validations[0]?.outcome.initial.status, "timeout");

    const messages: LspDiagnosticsMessage[] = [];
    const prepared = prepareBashDiagnostics({
      validations: result.validations,
      cwd: root,
      sendMessage: (message) => messages.push(message),
    });
    assert.match(prepared.content, /timed out, may be incomplete/u);
    await Promise.all(prepared.lateDeliveries);
    assert.equal(messages.length, 1);
    assert.match(messages[0]?.content ?? "", /bash error/u);
  });
});
