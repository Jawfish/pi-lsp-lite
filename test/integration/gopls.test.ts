import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServerManager } from "../../src/server-manager.js";
import { builtinLanguages as languages } from "../../src/languages.js";
import { pollUntil } from "../poll-until.js";
import { handleFinal } from "../server-manager-helpers.js";
import {
  captureBashChangeSnapshot,
  resyncAfterBash,
} from "../../src/bash-awareness.js";

const goConfig = languages.find((l) => l.id === "go")!;
const execFileAsync = promisify(execFile);

describe("gopls integration", { skip: !process.env.INTEGRATION }, () => {
  let manager: ReturnType<typeof createServerManager>;
  let dir: string;

  before(async () => {
    manager = createServerManager({ maxRetries: 0 });
    dir = join(tmpdir(), `pi-lsp-gopls-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "go.mod"), "module example.com/test\n\ngo 1.21\n");

    // warmup: absorb cold start
    await writeFile(join(dir, "warmup.go"), "package main\n");
    const warmup = await handleFinal(manager, join(dir, "warmup.go"), goConfig, dir);
    assert.notEqual(warmup.status, "unavailable", "gopls is not available — cannot run integration tests");
  });

  after(async () => {
    await manager.shutdownAll();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports syntax error", async () => {
    const filePath = join(dir, "syntax_error.go");
    await writeFile(filePath, "package main\n\nfunc main() {\n  fmt.Println(\n}\n");

    const result = await pollUntil(
      () => handleFinal(manager, filePath, goConfig, dir),
      (r) => r.diagnostics.some((d) => d.severity === 1),
    );

    assert.equal(result.status, "ok");
    assert.ok(result.diagnostics.some((d) => d.severity === 1), "expected at least one error diagnostic for syntax error");

    // fix the error so it doesn't pollute subsequent tests
    await writeFile(filePath, "package main\n");
    await handleFinal(manager, filePath, goConfig, dir);
  });

  it("reports no errors for clean file", async () => {
    const filePath = join(dir, "clean.go");
    await writeFile(filePath, 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n');

    const result = await pollUntil(
      () => handleFinal(manager, filePath, goConfig, dir),
      (r) => !r.diagnostics.some((d) => d.severity === 1),
    );

    const hasErrors = result.diagnostics.some((d) => d.severity === 1);
    assert.equal(hasErrors, false, "expected no error diagnostics on clean file");
  });

  it("detects a syntax error written by bash", async () => {
    const filePath = join(dir, "bash_edit.go");
    await writeFile(filePath, "package main\n");
    await handleFinal(manager, filePath, goConfig, dir);
    const before = await captureBashChangeSnapshot(manager);
    assert.ok(before);

    await execFileAsync(
      "bash",
      [
        "-c",
        `printf 'package main\\n\\nfunc broken( {\\n' > "$1"`,
        "pi-lsp-lite",
        filePath,
      ],
      { cwd: dir },
    );
    const { validations } = await resyncAfterBash({
      before,
      manager,
      servers: [goConfig],
      cwd: dir,
    });
    assert.equal(validations.length, 1);
    const outcome = validations[0]!.outcome;
    const result = (await outcome.pending) ?? outcome.initial;

    assert.equal(result.status, "ok");
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.severity === 1),
      "expected gopls to report the bash-written syntax error",
    );

    await writeFile(filePath, "package main\n");
    await handleFinal(manager, filePath, goConfig, dir);
  });

  it("detects cross-file breakage", async () => {
    await writeFile(
      join(dir, "lib.go"),
      "package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n",
    );
    await writeFile(
      join(dir, "caller.go"),
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(Add(1, 2))\n}\n',
    );

    // open both files so gopls tracks them
    await handleFinal(manager, join(dir, "caller.go"), goConfig, dir);
    await handleFinal(manager, join(dir, "lib.go"), goConfig, dir);

    // break the signature
    await writeFile(
      join(dir, "lib.go"),
      "package main\n\nfunc Add(a, b, c int) int {\n\treturn a + b + c\n}\n",
    );

    const result = await pollUntil(
      () => handleFinal(manager, join(dir, "lib.go"), goConfig, dir),
      (r) => {
        const totalDiags = r.diagnostics.filter((d) => d.severity === 1).length
          + r.otherFiles.reduce((s, f) => s + f.errorCount, 0);
        return totalDiags > 0;
      },
    );

    assert.equal(result.status, "ok");
    const totalDiags = result.diagnostics.filter((d) => d.severity === 1).length
      + result.otherFiles.reduce((s, f) => s + f.errorCount, 0);
    assert.ok(totalDiags > 0, "expected diagnostics from cross-file breakage");
  });
});
