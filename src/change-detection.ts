import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_MARKER_FILES = [
  "go.mod",
  "Cargo.toml",
  "tsconfig.json",
  "package.json",
  "compile_commands.json",
] as const;

export interface ChangeDetectionTarget {
  serverKey: string;
  root: string;
  rootPatterns: string[];
  documentUris: string[];
}

export interface FileMetadata {
  mtimeMs: number;
  size: number;
}

export type TrackedFileKind = "document" | "marker";

export interface FileSnapshotEntry {
  path: string;
  kinds: TrackedFileKind[];
  serverKeys: string[];
  metadata: FileMetadata | null;
}

export type FileSnapshot = Map<string, FileSnapshotEntry>;

export interface FileSnapshotDiff {
  changed: FileSnapshotEntry[];
  deleted: FileSnapshotEntry[];
}

export type ReadFileMetadata = (path: string) => Promise<FileMetadata | null>;

async function readFileMetadata(path: string): Promise<FileMetadata | null> {
  try {
    const metadata = await stat(path);
    return { mtimeMs: metadata.mtimeMs, size: metadata.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

interface SnapshotCandidate {
  kinds: Set<TrackedFileKind>;
  serverKeys: Set<string>;
}

function addCandidate(
  candidates: Map<string, SnapshotCandidate>,
  path: string,
  kind: TrackedFileKind,
  serverKey: string,
): void {
  const candidate = candidates.get(path) ?? {
    kinds: new Set<TrackedFileKind>(),
    serverKeys: new Set<string>(),
  };
  candidate.kinds.add(kind);
  candidate.serverKeys.add(serverKey);
  candidates.set(path, candidate);
}

export async function snapshotTrackedFiles(
  targets: readonly ChangeDetectionTarget[],
  readMetadata: ReadFileMetadata = readFileMetadata,
): Promise<FileSnapshot> {
  if (targets.length === 0) return new Map();

  const candidates = new Map<string, SnapshotCandidate>();
  for (const target of targets) {
    for (const uri of target.documentUris) {
      addCandidate(candidates, fileURLToPath(uri), "document", target.serverKey);
    }
    const rootMarkers = new Set([...ROOT_MARKER_FILES, ...target.rootPatterns]);
    for (const marker of rootMarkers) {
      addCandidate(candidates, join(target.root, marker), "marker", target.serverKey);
    }
  }

  const snapshot = new Map<string, FileSnapshotEntry>();
  await Promise.all(
    [...candidates].map(async ([path, candidate]) => {
      snapshot.set(path, {
        path,
        kinds: [...candidate.kinds].sort(),
        serverKeys: [...candidate.serverKeys].sort(),
        metadata: await readMetadata(path),
      });
    }),
  );
  return snapshot;
}

function metadataEqual(
  left: FileMetadata | null | undefined,
  right: FileMetadata | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export function diffFileSnapshots(
  before: FileSnapshot,
  after: FileSnapshot,
): FileSnapshotDiff {
  const changed: FileSnapshotEntry[] = [];
  const deleted: FileSnapshotEntry[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);

  for (const path of paths) {
    const previous = before.get(path);
    const current = after.get(path);
    if (metadataEqual(previous?.metadata, current?.metadata)) continue;

    if (previous?.metadata && !current?.metadata) {
      deleted.push(current ?? previous);
    } else if (current?.metadata) {
      changed.push(current);
    }
  }

  return {
    changed: changed.sort((left, right) => left.path.localeCompare(right.path)),
    deleted: deleted.sort((left, right) => left.path.localeCompare(right.path)),
  };
}
