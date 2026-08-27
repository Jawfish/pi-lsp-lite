import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderDiagnosticMessage,
  type DiagnosticMessageTheme,
} from "../src/message-renderer.js";

const theme: DiagnosticMessageTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

const content = `
⚠ LSP diagnostics for src/main.ts (1 error, 1 warning):
  src/main.ts:2:4: error[TS1001]: broken [ts]
    | broken()
  pre-existing:
  src/main.ts:5:1: warning[TS2002]: old warning [ts]
    ↳ src/other.ts:8:2: related declaration`;

describe("diagnostic message renderer", () => {
  it("keeps collapsed output compact with themed severity and paths", () => {
    const rendered = renderDiagnosticMessage(
      { content, details: { filePath: "src/main.ts" } },
      false,
      theme,
    );

    assert.match(
      rendered,
      /diagnostics for <dim>src\/main\.ts<\/dim>/u,
    );
    assert.match(
      rendered,
      /<dim>src\/main\.ts<\/dim>:2:4: <error>error\[TS1001\]: broken \[ts\]<\/error>/u,
    );
    assert.match(rendered, /<dim>  … 4 more lines<\/dim>/u);
    assert.doesNotMatch(rendered, /old warning/u);
  });

  it("shows full themed output when expanded", () => {
    const rendered = renderDiagnosticMessage(
      { content, details: { filePath: "src/main.ts" } },
      true,
      theme,
    );

    assert.match(
      rendered,
      /<warning>warning\[TS2002\]: old warning \[ts\]<\/warning>/u,
    );
    assert.match(
      rendered,
      /↳ <dim>src\/other\.ts<\/dim>:8:2: related declaration/u,
    );
    assert.match(rendered, /\| broken\(\)/u);
    assert.doesNotMatch(rendered, /more lines/u);
  });

  it("falls back for malformed content and details", () => {
    assert.equal(
      renderDiagnosticMessage(
        { content: 42, details: { filePath: 17 } },
        false,
        theme,
      ),
      "⚠ LSP diagnostics",
    );
    assert.equal(
      renderDiagnosticMessage(
        {
          content: "  odd.ts:1:1: warning: malformed details",
          details: "bad",
        },
        true,
        theme,
      ),
      "<dim>odd.ts</dim>:1:1: <warning>warning: malformed details</warning>",
    );
  });
});
