import type { LanguageServerConfig } from "./languages.js";
import { languageForFile } from "./languages.js";
import type {
  EditDiagnosticOutcome,
  RoutedWatchedFileChange,
  ServerManager,
} from "./server-manager.js";
import {
  diffFileSnapshots,
  snapshotTrackedFiles,
  type ChangeDetectionTarget,
  type FileSnapshot,
  type FileSnapshotDiff,
} from "./change-detection.js";
import { formatDiagnostics } from "./format.js";
import {
  deliverLateDiagnostics,
  LSP_DIAGNOSTICS_MESSAGE_TYPE,
  type LspDiagnosticsMessage,
  type SendLspDiagnosticsMessage,
} from "./late-delivery.js";
import { FileChangeType } from "vscode-languageserver-protocol";
import { fileUri } from "./util.js";

export interface BashChangeSnapshot {
  targets: ChangeDetectionTarget[];
  files: FileSnapshot;
}

export interface BashValidationResult {
  filePath: string;
  outcome: EditDiagnosticOutcome;
}

export interface BashResyncResult {
  diff: FileSnapshotDiff;
  validations: BashValidationResult[];
}

export interface ResyncAfterBashOptions {
  before: BashChangeSnapshot;
  manager: ServerManager;
  servers: LanguageServerConfig[];
  cwd: string;
  signal?: AbortSignal;
}

export interface PrepareBashDiagnosticsOptions {
  validations: BashValidationResult[];
  cwd: string;
  sendMessage: SendLspDiagnosticsMessage;
  signal?: AbortSignal;
}

export interface QueueDiagnosticsAfterBashOptions
  extends ResyncAfterBashOptions {
  sendMessage: SendLspDiagnosticsMessage;
}

export interface PreparedBashDiagnostics {
  content: string;
  messages: LspDiagnosticsMessage[];
  lateDeliveries: Promise<void>[];
}

export async function captureBashChangeSnapshot(
  manager: Pick<ServerManager, "snapshotTargets">,
): Promise<BashChangeSnapshot | null> {
  const targets = manager.snapshotTargets();
  if (targets.length === 0) return null;
  return {
    targets,
    files: await snapshotTrackedFiles(targets),
  };
}

export async function resyncAfterBash({
  before,
  manager,
  servers,
  cwd,
  signal,
}: ResyncAfterBashOptions): Promise<BashResyncResult> {
  signal?.throwIfAborted();
  const after = await snapshotTrackedFiles(before.targets);
  signal?.throwIfAborted();
  const diff = diffFileSnapshots(before.files, after);

  for (const entry of diff.deleted) {
    if (entry.kinds.includes("document")) manager.closeDocument(entry.path);
  }

  const watchedFileChanges: RoutedWatchedFileChange[] = [
    ...diff.changed.map<RoutedWatchedFileChange>((entry) => ({
      serverKeys: entry.serverKeys,
      uri: fileUri(entry.path),
      type: before.files.get(entry.path)?.metadata
        ? FileChangeType.Changed
        : FileChangeType.Created,
    })),
    ...diff.deleted.map<RoutedWatchedFileChange>((entry) => ({
      serverKeys: entry.serverKeys,
      uri: fileUri(entry.path),
      type: FileChangeType.Deleted,
    })),
  ];
  manager.didChangeWatchedFiles(watchedFileChanges);

  const validations = await Promise.all(
    diff.changed
      .filter((entry) => entry.kinds.includes("document"))
      .map(async (entry): Promise<BashValidationResult | null> => {
        const config = languageForFile(entry.path, servers);
        if (!config) return null;
        const outcome = await manager.handleEdit(entry.path, config, cwd, {
          signal,
        });
        return outcome.superseded
          ? null
          : { filePath: entry.path, outcome };
      }),
  );

  return {
    diff,
    validations: validations.filter(
      (result): result is BashValidationResult => result !== null,
    ),
  };
}

export async function queueDiagnosticsAfterBash({
  sendMessage,
  ...resyncOptions
}: QueueDiagnosticsAfterBashOptions): Promise<PreparedBashDiagnostics> {
  const { validations } = await resyncAfterBash(resyncOptions);
  const prepared = prepareBashDiagnostics({
    validations,
    cwd: resyncOptions.cwd,
    sendMessage,
    signal: resyncOptions.signal,
  });
  for (const message of prepared.messages) {
    sendMessage(message, { deliverAs: "steer" });
  }
  return prepared;
}

export function prepareBashDiagnostics({
  validations,
  cwd,
  sendMessage,
  signal,
}: PrepareBashDiagnosticsOptions): PreparedBashDiagnostics {
  const content: string[] = [];
  const messages: LspDiagnosticsMessage[] = [];
  const lateDeliveries: Promise<void>[] = [];

  for (const { filePath, outcome } of validations) {
    const formatted = formatDiagnostics(
      filePath,
      outcome.initial,
      cwd,
      outcome.initial.documentContent,
    );
    if (formatted) {
      content.push(formatted);
      messages.push({
        customType: LSP_DIAGNOSTICS_MESSAGE_TYPE,
        content: formatted,
        display: true,
        details: { filePath },
      });
    }
    lateDeliveries.push(
      deliverLateDiagnostics({
        cwd,
        filePath,
        outcome,
        sendMessage,
        signal,
      }),
    );
  }

  return { content: content.join(""), messages, lateDeliveries };
}
