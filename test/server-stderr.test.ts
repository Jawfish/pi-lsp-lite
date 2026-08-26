import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterServerStderr } from "../src/server-manager.js";

describe("server stderr filtering", () => {
  it("suppresses benign context cancellation messages", () => {
    assert.equal(filterServerStderr("context cancelled\n"), "");
    assert.equal(filterServerStderr("  context canceled.  \r\n"), "");
  });

  it("preserves actionable stderr while removing benign lines", () => {
    assert.equal(
      filterServerStderr("context cancelled\ninitialization failed\n"),
      "initialization failed",
    );
  });
});
