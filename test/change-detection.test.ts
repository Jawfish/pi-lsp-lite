import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROOT_MARKER_FILES,
  diffFileSnapshots,
  snapshotTrackedFiles,
  type ChangeDetectionTarget,
} from "../src/change-detection.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `pi-lsp-change-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

function target(
  root: string,
  documentPaths: string[],
  rootPatterns: string[] = [],
): ChangeDetectionTarget {
  return {
    serverKey: `fake:${root}`,
    root,
    rootPatterns,
    documentUris: documentPaths.map((path) => pathToFileURL(path).href),
  };
}

describe("change detection snapshots", () => {
  it("covers open documents and standard and configured root markers", async () => {
    const root = await makeTempDir();
    const documentPath = join(root, "main.go");
    const customMarker = join(root, "custom.marker");
    await writeFile(documentPath, "package main\n");
    await writeFile(join(root, "go.mod"), "module example\n");
    await writeFile(customMarker, "enabled\n");

    const snapshot = await snapshotTrackedFiles([
      target(root, [documentPath], ["go.mod", "custom.marker"]),
    ]);

    const expectedPaths = new Set([
      documentPath,
      customMarker,
      ...ROOT_MARKER_FILES.map((marker) => join(root, marker)),
    ]);
    assert.deepEqual(new Set(snapshot.keys()), expectedPaths);
    assert.deepEqual(snapshot.get(documentPath)?.kinds, ["document"]);
    assert.deepEqual(snapshot.get(customMarker)?.kinds, ["marker"]);
    assert.ok(snapshot.get(documentPath)?.metadata);
    assert.ok(snapshot.get(join(root, "go.mod"))?.metadata);
    assert.equal(snapshot.get(join(root, "Cargo.toml"))?.metadata, null);
  });

  it("classifies changed, deleted, created, and unchanged files", async () => {
    const root = await makeTempDir();
    const changedPath = join(root, "changed.go");
    const deletedPath = join(root, "deleted.go");
    const unchangedPath = join(root, "unchanged.go");
    const createdMarker = join(root, "custom.marker");
    await writeFile(changedPath, "old\n");
    await writeFile(deletedPath, "delete me\n");
    await writeFile(unchangedPath, "same\n");
    const targets = [
      target(
        root,
        [changedPath, deletedPath, unchangedPath],
        ["custom.marker"],
      ),
    ];
    const before = await snapshotTrackedFiles(targets);

    await writeFile(changedPath, "new content with a different size\n");
    await rm(deletedPath);
    await writeFile(createdMarker, "created\n");
    const after = await snapshotTrackedFiles(targets);
    const diff = diffFileSnapshots(before, after);

    assert.deepEqual(
      new Set(diff.changed.map(({ path }) => path)),
      new Set([changedPath, createdMarker]),
    );
    assert.deepEqual(
      new Set(diff.deleted.map(({ path }) => path)),
      new Set([deletedPath]),
    );
    assert.ok(!diff.changed.some(({ path }) => path === unchangedPath));
    assert.ok(!diff.deleted.some(({ path }) => path === unchangedPath));
  });

  it("returns an empty snapshot without reading metadata when no server runs", async () => {
    let readCount = 0;
    const snapshot = await snapshotTrackedFiles([], async () => {
      readCount++;
      return { mtimeMs: 0, size: 0 };
    });

    assert.equal(snapshot.size, 0);
    assert.equal(readCount, 0);
    assert.deepEqual(diffFileSnapshots(snapshot, snapshot), {
      changed: [],
      deleted: [],
    });
  });
});
