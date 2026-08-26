import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { EditDiagnosticResult } from "../src/server-manager.js";
import {
  deliverLateDiagnostics,
  type LspDiagnosticsMessage,
} from "../src/late-delivery.js";
import { formatDiagnostics } from "../src/format.js";

function diagnostic(message: string): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    severity: DiagnosticSeverity.Error,
    message,
    source: "fake",
  };
}

function result(diagnostics: Diagnostic[]): EditDiagnosticResult {
  return {
    status: "ok",
    diagnostics,
    otherFiles: [],
    retryAttempts: 0,
    delta: { hasBaseline: false },
    documentContent: "const value = broken;",
  };
}

describe("late diagnostic delivery", () => {
  it("does not send an identical final result", async () => {
    const initial = result([diagnostic("same error")]);
    const sent: LspDiagnosticsMessage[] = [];

    await deliverLateDiagnostics({
      cwd: "/repo",
      filePath: "src/main.ts",
      outcome: {
        initial,
        pending: Promise.resolve(result([diagnostic("same error")])),
      },
      sendMessage: (message) => sent.push(message),
    });

    assert.equal(sent.length, 0);
  });

  it("sends a differing final result as a steer message", async () => {
    const initial = result([]);
    const final = result([diagnostic("late error")]);
    const sent: Array<{
      message: LspDiagnosticsMessage;
      options: { deliverAs: "steer" };
    }> = [];

    await deliverLateDiagnostics({
      cwd: "/repo",
      filePath: "src/main.ts",
      outcome: { initial, pending: Promise.resolve(final) },
      sendMessage: (message, options) => sent.push({ message, options }),
    });

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].options, { deliverAs: "steer" });
    assert.equal(sent[0].message.customType, "lsp-lite-diagnostics");
    assert.equal(sent[0].message.display, true);
    assert.deepEqual(sent[0].message.details, { filePath: "src/main.ts" });
    assert.equal(
      sent[0].message.content,
      formatDiagnostics("src/main.ts", final, "/repo", final.documentContent),
    );
    assert.ok(sent[0].message.content.includes("src/main.ts"));
  });

  it("sends an explicit clean result when late diagnostics disappear", async () => {
    const sent: LspDiagnosticsMessage[] = [];

    await deliverLateDiagnostics({
      cwd: "/repo",
      filePath: "src/main.ts",
      outcome: {
        initial: result([diagnostic("temporary error")]),
        pending: Promise.resolve(result([])),
      },
      sendMessage: (message) => sent.push(message),
    });

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].content,
      "\n⚠ LSP diagnostics for src/main.ts: no issues",
    );
  });

  it("suppresses delivery after abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const sent: LspDiagnosticsMessage[] = [];

    await deliverLateDiagnostics({
      cwd: "/repo",
      filePath: "src/main.ts",
      outcome: {
        initial: result([]),
        pending: Promise.resolve(result([diagnostic("stale error")])),
      },
      sendMessage: (message) => sent.push(message),
      signal: controller.signal,
    });

    assert.equal(sent.length, 0);
  });
});
