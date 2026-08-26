import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDiagnosticLine, formatDiagnostics } from "../src/format.js";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { DiagnosticResult } from "../src/client.js";
import { pathToFileURL } from "node:url";

function makeDiag(severity: DiagnosticSeverity, message: string, line = 0, col = 0): Diagnostic {
  return {
    range: { start: { line, character: col }, end: { line, character: col + 5 } },
    severity,
    message,
    source: "test",
  };
}

describe("formatDiagnostics", () => {
  it("formats ok result with errors and warnings", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [
        makeDiag(DiagnosticSeverity.Error, "undefined variable", 4, 10),
        makeDiag(DiagnosticSeverity.Warning, "unused import", 1, 0),
      ],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("1 error"));
    assert.ok(output.includes("1 warning"));
    assert.ok(output.includes("main.go:5:11: error: undefined variable [test]"));
    assert.ok(output.includes("main.go:2:1: warning: unused import [test]"));
  });

  it("renders delta counts with new diagnostics and excerpts first", () => {
    const preExisting = [
      makeDiag(DiagnosticSeverity.Error, "old first", 0),
      makeDiag(DiagnosticSeverity.Warning, "old second", 1),
    ];
    const newDiagnostics = Array.from({ length: 5 }, (_, index) =>
      makeDiag(DiagnosticSeverity.Error, `new ${index + 1}`, index + 2),
    );
    const diagnostics = [
      preExisting[0],
      newDiagnostics[0],
      preExisting[1],
      ...newDiagnostics.slice(1),
    ];
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics,
      otherFiles: [],
      retryAttempts: 0,
      delta: {
        hasBaseline: true,
        diagnostics: [
          { diagnostic: preExisting[0], classification: "pre-existing" },
          { diagnostic: newDiagnostics[0], classification: "new" },
          { diagnostic: preExisting[1], classification: "pre-existing" },
          ...newDiagnostics.slice(1).map((diagnostic) => ({
            diagnostic,
            classification: "new" as const,
          })),
        ],
        fixedCount: 1,
      },
    };
    const content = [
      "old first line",
      "old second line",
      "new line 1",
      "new line 2",
      "new line 3",
      "new line 4",
      "new line 5",
    ].join("\n");

    const output = formatDiagnostics("main.go", result, undefined, content);
    assert.ok(output.includes("5 new, 2 pre-existing, 1 fixed"));
    assert.ok(output.indexOf("new 1") < output.indexOf("  pre-existing:"));
    assert.ok(output.indexOf("  pre-existing:") < output.indexOf("old first"));
    assert.ok(output.includes("    | new line 5"));
    assert.ok(!output.includes("    | old first line"), `expected new excerpts first in: ${output}`);
  });

  it("omits delta markers when classification has no baseline", () => {
    const diagnostic = makeDiag(DiagnosticSeverity.Error, "existing error");
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [diagnostic],
      otherFiles: [],
      retryAttempts: 0,
      delta: { hasBaseline: false },
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("1 error"));
    assert.ok(!output.includes("pre-existing:"));
    assert.ok(!output.includes(" fixed"));
  });

  it("reports fixed diagnostics when no findings remain", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 0,
      delta: {
        hasBaseline: true,
        diagnostics: [],
        fixedCount: 2,
      },
    };

    assert.equal(
      formatDiagnostics("main.go", result),
      "\n⚠ LSP diagnostics for main.go (0 new, 0 pre-existing, 2 fixed)",
    );
  });

  it("includes codes and omits absent code and source cleanly", () => {
    const withCode = makeDiag(DiagnosticSeverity.Error, "not assignable", 2, 4);
    withCode.code = "TS2322";
    assert.equal(
      formatDiagnosticLine("/project/src/main.ts", withCode, "/project"),
      "  src/main.ts:3:5: error[TS2322]: not assignable [test]",
    );

    const withoutCodeOrSource = makeDiag(DiagnosticSeverity.Warning, "unused", 0, 0);
    delete withoutCodeOrSource.source;
    assert.equal(
      formatDiagnosticLine("main.ts", withoutCodeOrSource),
      "  main.ts:1:1: warning: unused",
    );
  });

  it("renders at most two related locations with relative paths", () => {
    const diagnostic = makeDiag(DiagnosticSeverity.Error, "cannot resolve symbol");
    diagnostic.relatedInformation = [
      {
        location: {
          uri: "file:///project/src/first.ts",
          range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } },
        },
        message: "first declaration",
      },
      {
        location: {
          uri: "file:///project/src/second.ts",
          range: { start: { line: 8, character: 0 }, end: { line: 8, character: 1 } },
        },
        message: "second declaration",
      },
      {
        location: {
          uri: "file:///project/src/third.ts",
          range: { start: { line: 12, character: 1 }, end: { line: 12, character: 2 } },
        },
        message: "third declaration",
      },
    ];
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [diagnostic],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("/project/src/main.ts", result, "/project");
    assert.ok(output.includes("    ↳ src/first.ts:5:3: first declaration"));
    assert.ok(output.includes("    ↳ src/second.ts:9:1: second declaration"));
    assert.ok(!output.includes("third declaration"), `expected related information cap in: ${output}`);
  });

  it("renders five trimmed source excerpts and skips invalid ranges", () => {
    const longLine = `  ${"x".repeat(130)}  `;
    const content = ["  first line  ", longLine, "third", "fourth", "fifth", "sixth"].join("\n");
    const diagnostics = Array.from({ length: 6 }, (_, line) =>
      makeDiag(DiagnosticSeverity.Error, `issue ${line + 1}`, line),
    );
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics,
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.ts", result, undefined, content);
    assert.ok(output.includes("    | first line"));
    assert.ok(output.includes("    | third"));
    assert.ok(output.includes("    | fifth"));
    assert.ok(!output.includes("    | sixth"), `expected source excerpt cap in: ${output}`);
    const truncated = output.split("\n").find((line) => line.startsWith("    | xxx"));
    assert.equal(truncated?.slice("    | ".length).length, 120);
    assert.ok(truncated?.endsWith("..."));

    const invalidRangeResult: DiagnosticResult = {
      ...result,
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "outside content", 99)],
    };
    const invalidOutput = formatDiagnostics("main.ts", invalidRangeResult, undefined, content);
    assert.ok(!invalidOutput.split("\n").some((line) => line.startsWith("    | ")));
  });

  it("returns empty string for ok result with no diagnostics", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.equal(output, "");
  });

  it("returns timeout message for timeout with no diagnostics", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("timed out"));
    assert.ok(output.includes("main.go"));
  });

  it("includes 'timed out, may be incomplete' for timeout with diagnostics", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "some error")],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("timed out, may be incomplete"));
    assert.ok(output.includes("1 error"));
    assert.ok(output.includes("some error"));
  });

  it("shows up to three diagnostics per file in the cross-file footer", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "type mismatch")],
      otherFiles: [
        {
          uri: "file:///project/other.go",
          errorCount: 2,
          warningCount: 2,
          topDiagnostics: [
            { ...makeDiag(DiagnosticSeverity.Error, "too many arguments", 4, 2), source: "compiler" },
            { ...makeDiag(DiagnosticSeverity.Error, "undefined name", 7, 0), source: "compiler" },
            { ...makeDiag(DiagnosticSeverity.Warning, "unused value", 9, 1), source: "compiler" },
            { ...makeDiag(DiagnosticSeverity.Warning, "fourth detail", 11, 1), source: "compiler" },
          ],
        },
        {
          uri: "file:///project/another.go",
          errorCount: 0,
          warningCount: 1,
          topDiagnostics: [
            { ...makeDiag(DiagnosticSeverity.Warning, "unused import"), source: "compiler" },
          ],
        },
      ],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("/project/other.go (2 errors, 2 warnings):"), `expected per-file counts in: ${output}`);
    assert.ok(output.includes("/project/other.go:5:3: error: too many arguments [compiler]"), `expected error detail in: ${output}`);
    assert.ok(output.includes("/project/other.go:10:2: warning: unused value [compiler]"), `expected warning detail in: ${output}`);
    assert.ok(!output.includes("fourth detail"), `expected three-diagnostic cap in: ${output}`);
    assert.ok(output.includes("/project/another.go:1:1: warning: unused import [compiler]"), `expected per-file detail in: ${output}`);
  });

  it("shows relative paths when cwd is provided", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [
        {
          uri: "file:///project/src/other.go",
          errorCount: 1,
          warningCount: 0,
          topDiagnostics: [
            { ...makeDiag(DiagnosticSeverity.Error, "undefined: bar", 9, 4), source: undefined },
          ],
        },
      ],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result, "/project");
    assert.ok(output.includes("src/other.go:10:5: error: undefined: bar"), `expected relative path in: ${output}`);
  });

  it("shows other-file footer even when main file has no issues", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [{ uri: "file:///project/other.go", errorCount: 1, warningCount: 0, topDiagnostics: [] }],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("/project/other.go (1 error)"), `expected file path in: ${output}`);
  });

  it("filters out info and hint severity diagnostics", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [
        makeDiag(DiagnosticSeverity.Information, "info message"),
        makeDiag(DiagnosticSeverity.Hint, "hint message"),
      ],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.equal(output, "");
  });

  it("includes retry count in timeout message when retryAttempts > 0", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [makeDiag(DiagnosticSeverity.Error, "some error")],
      otherFiles: [],
      retryAttempts: 3,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("after 3 retries"), `expected 'after 3 retries' in: ${output}`);
    assert.ok(output.includes("timed out"));
    assert.ok(output.includes("may be incomplete"));
  });

  it("uses singular 'retry' when retryAttempts is 1", () => {
    const result: DiagnosticResult = {
      status: "timeout",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 1,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("after 1 retry"), `expected 'after 1 retry' in: ${output}`);
  });

  it("surfaces unavailable status instead of returning empty", () => {
    const result: DiagnosticResult = {
      status: "unavailable",
      diagnostics: [],
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("unavailable"), `expected 'unavailable' in: ${output}`);
    assert.ok(output.includes("main.go"), `expected file path in: ${output}`);
    assert.ok(output.includes("server missing or failed to start"), `expected reason in: ${output}`);
  });

  it("truncates diagnostics beyond cap with a note", () => {
    const diags = Array.from({ length: 60 }, (_, i) =>
      makeDiag(DiagnosticSeverity.Error, `error ${i}`, i),
    );
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: diags,
      otherFiles: [],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("main.go", result);
    assert.ok(output.includes("60 errors"), `expected full count in summary: ${output}`);
    assert.ok(output.includes("... and 10 more"), `expected truncation note: ${output}`);
    const errorLines = output.split("\n").filter((line) => line.includes(": error:"));
    assert.equal(errorLines.length, 50, "should show at most 50 diagnostic lines");
  });
});

describe("formatDiagnostics (Windows)", { skip: process.platform !== "win32" }, () => {
  it("relativizes a drive-letter cross-file URI against cwd", () => {
    const result: DiagnosticResult = {
      status: "ok",
      diagnostics: [],
      otherFiles: [
        {
          uri: pathToFileURL("C:\\project\\src\\other.ts").href,
          errorCount: 1,
          warningCount: 0,
          topDiagnostics: [
            { ...makeDiag(DiagnosticSeverity.Error, "undefined: bar", 9, 4), source: undefined },
          ],
        },
      ],
      retryAttempts: 0,
    };

    const output = formatDiagnostics("src\\main.ts", result, "C:\\project");
    assert.ok(
      output.includes("src\\other.ts:10:5: error: undefined: bar"),
      `expected relativized windows path in: ${output}`,
    );
  });
});
