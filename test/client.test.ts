import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createLspClient } from "../src/client.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeServerPath = join(__dirname, "fake-server.ts");

function spawnFake(options: Record<string, unknown> = {}) {
  const args = ["--import", "tsx", fakeServerPath, "--run"];
  if (Object.keys(options).length > 0) {
    args.push(`--options=${JSON.stringify(options)}`);
  }
  return spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("LspClient", () => {
  it("receives diagnostics after didOpen", async () => {
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "fake error");

    await client.shutdown();
  });

  it("advertises and preserves diagnostic related information", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const relatedUri = "file:///tmp/test-workspace/types.go";
    const child = spawnFake({
      diagnosticsByUri: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            code: "FAKE1001",
            message: "fake error with context",
            source: "fake",
            relatedInformation: [
              {
                location: {
                  uri: relatedUri,
                  range: { start: { line: 3, character: 1 }, end: { line: 3, character: 4 } },
                },
                message: "declared here",
              },
            ],
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "go", "package main");
    const result = await client.waitForDiagnostics(uri, 2000);

    assert.equal(result.diagnostics[0].code, "FAKE1001");
    assert.equal(result.diagnostics[0].relatedInformation?.length, 1);
    assert.equal(result.diagnostics[0].relatedInformation?.[0].location.uri, relatedUri);
    assert.equal(result.diagnostics[0].relatedInformation?.[0].message, "declared here");

    await client.shutdown();
  });

  it("returns ok with empty diagnostics for clean file", async () => {
    const child = spawnFake({
      diagnosticsByUri: { "file:///tmp/test-workspace/clean.go": [] },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/clean.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);

    await client.shutdown();
  });

  it("returns ok even with delayed diagnostics", async () => {
    const child = spawnFake({ diagnosticDelay: 500 });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);

    await client.shutdown();
  });

  it("returns a non-retryable timeout when a push server suppresses an unchanged result", async () => {
    const uri = "file:///tmp/test-workspace/clean.go";
    const child = spawnFake({
      diagnosticsByUri: { [uri]: [] },
      publishOnlyOnce: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "go", "package main");
    const first = await client.waitForDiagnostics(uri, 2000);
    assert.equal(first.status, "ok");

    client.didChange(uri, "package main\n");
    const second = await client.waitForDiagnostics(uri, 100);
    assert.equal(second.status, "timeout");
    assert.equal(second.retryable, false);
    assert.equal(second.diagnostics.length, 0);

    await client.shutdown();
  });

  it("pulls diagnostics when the server advertises a diagnostic provider", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const child = spawnFake({
      diagnosticsByUri: {
        [uri]: [
          {
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
            severity: 1,
            message: "pulled error",
            source: "fake-pull",
          },
        ],
      },
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "const value: string = 1;");
    const result = await client.waitForDiagnostics(uri, 2000);

    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "pulled error");

    await client.shutdown();
  });

  it("retriggers a pull when the server cancels the request", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const child = spawnFake({
      pullCancelAttempts: 1,
      pullCancelWithoutData: true,
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "const value: string = 1;");
    const result = await client.waitForDiagnostics(uri, 2000);

    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 1);

    await client.shutdown();
  });

  it("does not retry a pull when the server forbids retriggering", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const child = spawnFake({
      pullCancelAttempts: 1,
      pullCancelRetrigger: false,
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "const value: string = 1;");
    const result = await client.waitForDiagnostics(uri, 2000);

    assert.equal(result.status, "timeout");
    assert.equal(result.retryable, false);

    await client.shutdown();
  });

  it("retains diagnostics when a pull server returns unchanged", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const child = spawnFake({
      pullDiagnostics: true,
      pullUnchangedAfterFirst: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "const value: string = 1;");
    const first = await client.waitForDiagnostics(uri, 2000);
    assert.equal(first.diagnostics.length, 1);

    client.didChange(uri, "const value: string = 2;");
    const second = await client.waitForDiagnostics(uri, 2000);
    assert.equal(second.status, "ok");
    assert.equal(second.diagnostics.length, 1);
    assert.equal(second.diagnostics[0].message, "fake error");

    await client.shutdown();
  });

  it("collects related documents from a pull diagnostic report", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const otherUri = "file:///tmp/test-workspace/other.ts";
    const child = spawnFake({
      diagnosticsByUri: { [uri]: [] },
      otherFileDiagnostics: {
        [otherUri]: [
          {
            range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
            severity: 1,
            message: "related error",
            source: "fake-pull",
          },
        ],
      },
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "export const value = 1;");
    const result = await client.waitForDiagnostics(uri, 2000);

    assert.equal(result.status, "ok");
    assert.equal(result.otherFiles.length, 1);
    assert.equal(result.otherFiles[0].uri, otherUri);
    assert.equal(result.otherFiles[0].errorCount, 1);

    await client.shutdown();
  });

  it("keeps a newer push report but clears it on the next clean pull", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const pushedDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: "pushed project error",
      source: "fake-push",
    };
    const child = spawnFake({
      diagnosticsByUri: { [uri]: [] },
      pullDiagnostics: true,
      pushAfterPullDelay: 20,
      pushAfterPullDiagnostics: { [uri]: [pushedDiagnostic] },
      pushAfterPullOnlyOnce: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "export const value = 1;");
    const first = await client.waitForDiagnostics(uri, 2000);
    assert.equal(first.diagnostics[0]?.message, "pushed project error");

    client.didChange(uri, "export const value = 2;");
    const second = await client.waitForDiagnostics(uri, 2000);
    assert.equal(second.diagnostics.length, 0);

    await client.shutdown();
  });

  it("collects a pushed project diagnostic after pull reports finish", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const configUri = "file:///tmp/test-workspace/tsconfig.json";
    const child = spawnFake({
      diagnosticsByUri: { [uri]: [] },
      pullDiagnostics: true,
      pushAfterPullDelay: 20,
      pushAfterPullDiagnostics: {
        [configUri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: "config error",
            source: "fake-push",
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "export const value = 1;");
    const result = await client.waitForDiagnostics(uri, 2000);

    assert.equal(result.status, "ok");
    assert.equal(result.otherFiles[0]?.uri, configUri);
    assert.equal(result.otherFiles[0]?.errorCount, 1);

    await client.shutdown();
  });

  it("keeps a completed target report when another open document stalls", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const stalledUri = "file:///tmp/test-workspace/stalled.ts";
    const child = spawnFake({
      neverPullUris: [stalledUri],
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(stalledUri, "typescript", "export const stalled = true;");
    client.didOpen(uri, "typescript", "const value: string = 1;");
    const result = await client.waitForDiagnostics(uri, 100);

    assert.equal(result.status, "timeout");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "fake error");

    await client.shutdown();
  });

  it("does not apply a pull report after the document closes", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const child = spawnFake({
      pullDelay: 100,
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "const value: string = 1;");
    const pending = client.waitForDiagnostics(uri, 1000);
    client.didClose(uri);
    const result = await pending;

    assert.equal(result.status, "ok");
    assert.equal(result.diagnostics.length, 0);
    assert.equal(client.getAllDiagnostics().has(uri), false);

    await client.shutdown();
  });

  it("ignores a pull report that arrives after the timeout", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const child = spawnFake({
      pullDelay: 200,
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "typescript", "const value: string = 1;");
    const result = await client.waitForDiagnostics(uri, 50);
    assert.equal(result.status, "timeout");

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(client.getAllDiagnostics().has(uri), false);

    await client.shutdown();
  });

  it("accepts a current related report for a document closed before the pull", async () => {
    const uri = "file:///tmp/test-workspace/main.ts";
    const otherUri = "file:///tmp/test-workspace/other.ts";
    const child = spawnFake({
      diagnosticsByUri: { [uri]: [], [otherUri]: [] },
      otherFileDiagnostics: {
        [otherUri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: "closed caller error",
            source: "fake-pull",
          },
        ],
      },
      pullDiagnostics: true,
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(otherUri, "typescript", "export const other = true;");
    await client.waitForDiagnostics(otherUri, 2000);
    client.didClose(otherUri);
    client.didOpen(uri, "typescript", "export const value = 1;");
    const result = await client.waitForDiagnostics(uri, 2000);

    assert.equal(result.status, "ok");
    assert.equal(result.otherFiles[0]?.uri, otherUri);
    assert.equal(result.otherFiles[0]?.errorCount, 1);

    await client.shutdown();
  });

  it("returns timeout when server never publishes", async () => {
    const child = spawnFake({ neverPublish: true });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    const uri = "file:///tmp/test-workspace/main.go";
    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 500);
    assert.equal(result.status, "timeout");

    await client.shutdown();
  });

  it("returns latest diagnostics after rapid didChange", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const child = spawnFake({
      diagnosticDelay: 100,
      diagnosticsByUri: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: "latest error",
            source: "fake",
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(uri, "go", "package main\nfunc a() {}");
    client.didChange(uri, "package main\nfunc b() {}");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.length > 0);

    await client.shutdown();
  });

  it("didClose removes document so next didOpen is treated as fresh", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    // Open and wait for diagnostics once
    client.didOpen(uri, "go", "package main");
    const first = await client.waitForDiagnostics(uri, 2000);
    assert.equal(first.status, "ok");

    // Close the document — should remove tracking state
    client.didClose(uri);

    // Re-open: the client should send didOpen (not didChange) so fake server
    // publishes diagnostics again
    client.didOpen(uri, "go", "package main");
    const second = await client.waitForDiagnostics(uri, 2000);
    assert.equal(second.status, "ok");
    assert.equal(second.diagnostics.length, 1);

    await client.shutdown();
  });

  it("completes graceful shutdown", async () => {
    const child = spawnFake();
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");
    await client.shutdown();
    // no assertion needed — test passes if no error is thrown
  });

  it("ignores late diagnostics for a closed URI", async () => {
    const uri = "file:///tmp/test-workspace/ghost.go";
    const child = spawnFake({ diagnosticDelay: 200 });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    // open the document — triggers delayed publish after 200ms
    client.didOpen(uri, "go", "package main");

    // close immediately before diagnostics arrive
    client.didClose(uri);

    // wait enough time for the delayed publish to fire
    await new Promise((r) => setTimeout(r, 500));

    // the diagnostics handler should have ignored the publish for the closed URI
    // re-open the URI: if ghost diagnostics leaked, the entry would already exist
    // with stale data; a fresh didOpen should start clean
    client.didOpen(uri, "go", "package main");
    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    // the fake server publishes fresh diagnostics on didOpen, so we get "fake error"
    // the key assertion: we didn't accumulate ghost state from the closed-then-reopened cycle
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].message, "fake error");

    await client.shutdown();
  });

  it("collects other-file diagnostics", async () => {
    const uri = "file:///tmp/test-workspace/main.go";
    const otherUri = "file:///tmp/test-workspace/other.go";
    const child = spawnFake({
      diagnosticsByUri: {
        [otherUri]: [],
      },
      otherFileDiagnostics: {
        [otherUri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 2,
            message: "first warning",
            source: "fake",
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
            severity: 1,
            message: "first error",
            source: "fake",
          },
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
            severity: 1,
            message: "second error",
            source: "fake",
          },
          {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
            severity: 2,
            message: "second warning",
            source: "fake",
          },
          {
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } },
            severity: 1,
            message: "third error",
            source: "fake",
          },
        ],
      },
    });
    const client = createLspClient(child);
    await client.initialize("/tmp/test-workspace");

    client.didOpen(otherUri, "go", "package main");
    await client.waitForDiagnostics(otherUri, 2000);

    client.didOpen(uri, "go", "package main");

    const result = await client.waitForDiagnostics(uri, 2000);
    assert.equal(result.status, "ok");
    assert.ok(result.otherFiles.length > 0);
    assert.equal(result.otherFiles[0].uri, otherUri);
    assert.equal(result.otherFiles[0].errorCount, 3);
    assert.equal(result.otherFiles[0].warningCount, 2);
    assert.deepEqual(
      result.otherFiles[0].topDiagnostics.map((diagnostic) => diagnostic.message),
      ["first error", "second error", "third error"],
    );

    await client.shutdown();
  });

  it("getAllDiagnostics returns only URIs with non-empty diagnostics", async () => {
    const diag = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: "test error", severity: 1 };
    const child = spawnFake({ diagnosticsByUri: { "file:///test/error.ts": [diag] } });
    const client = createLspClient(child);
    await client.initialize("/test");

    client.didOpen("file:///test/error.ts", "typescript", "bad code");
    await client.waitForDiagnostics("file:///test/error.ts", 2000);

    const all = client.getAllDiagnostics();
    assert.ok(all.has("file:///test/error.ts"), "should include URI with diagnostics");
    assert.equal(all.get("file:///test/error.ts")!.length, 1);
    assert.equal(all.size, 1, "should only contain URIs with non-empty diagnostics");

    await client.shutdown();
  });
});
