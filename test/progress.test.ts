import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkingMessageController,
  type ValidationProgress,
} from "../src/progress.js";

function progress(
  phase: ValidationProgress["phase"],
  serverId: string,
  root: string,
  attempt = 1,
  totalAttempts = 4,
): ValidationProgress {
  return { phase, serverId, root, attempt, totalAttempts };
}

describe("validation working message", () => {
  it("names the server and attempt, then restores the default", () => {
    const messages: Array<string | undefined> = [];
    const controller = createWorkingMessageController((message) => {
      messages.push(message);
    });

    controller.handle(progress("start", "rust-analyzer", "/repo", 2));
    controller.handle(progress("end", "rust-analyzer", "/repo", 2));

    assert.deepEqual(messages, [
      "lsp: rust-analyzer validating (attempt 2/4)",
      undefined,
    ]);
  });

  it("keeps a combined message until concurrent validations finish", () => {
    const messages: Array<string | undefined> = [];
    const controller = createWorkingMessageController((message) => {
      messages.push(message);
    });

    controller.handle(progress("start", "rust-analyzer", "/rust"));
    controller.handle(progress("start", "gopls", "/go"));
    controller.handle(progress("end", "rust-analyzer", "/rust"));
    controller.handle(progress("end", "gopls", "/go"));

    assert.deepEqual(messages, [
      "lsp: rust-analyzer validating (attempt 1/4)",
      "lsp: rust-analyzer validating (attempt 1/4) +1 more",
      "lsp: gopls validating (attempt 1/4)",
      undefined,
    ]);
  });

  it("does not restore a message it did not set", () => {
    const messages: Array<string | undefined> = [];
    const controller = createWorkingMessageController((message) => {
      messages.push(message);
    });

    controller.handle(progress("end", "gopls", "/repo"));
    controller.reset();

    assert.deepEqual(messages, []);
  });

  it("ignores an end event for a superseded attempt", () => {
    const messages: Array<string | undefined> = [];
    const controller = createWorkingMessageController((message) => {
      messages.push(message);
    });

    controller.handle(progress("start", "gopls", "/repo", 2));
    controller.handle(progress("end", "gopls", "/repo", 1));
    controller.handle(progress("end", "gopls", "/repo", 2));

    assert.deepEqual(messages, [
      "lsp: gopls validating (attempt 2/4)",
      undefined,
    ]);
  });
});
