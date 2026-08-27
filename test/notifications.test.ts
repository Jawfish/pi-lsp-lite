import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnosticNotification } from "../src/notifications.js";

describe("diagnostic notifications", () => {
  it("does not duplicate normal diagnostic output", () => {
    assert.equal(
      diagnosticNotification("ok", "main.ts:1:1: error: broken"),
      undefined,
    );
    assert.equal(
      diagnosticNotification("timeout", "main.ts:1:1: error: incomplete"),
      undefined,
    );
  });

  it("keeps unavailable results visible", () => {
    assert.deepEqual(
      diagnosticNotification("unavailable", "\n[lsp] unavailable\n"),
      { message: "[lsp] unavailable", type: "warning" },
    );
  });
});
