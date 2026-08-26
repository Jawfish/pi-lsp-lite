import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  ShutdownRequest,
  ExitNotification,
  PublishDiagnosticsNotification,
  CancellationTokenSource,
  DiagnosticServerCancellationData,
  DiagnosticSeverity,
  DocumentDiagnosticReportKind,
  DocumentDiagnosticRequest,
  LSPErrorCodes,
  ResponseError,
  type InitializeParams,
  type Diagnostic,
  type DocumentDiagnosticReport,
} from "vscode-languageserver-protocol/node";
import type { ChildProcess } from "node:child_process";
import { fileUri } from "./util.js";
import { abortReason, abortableDelay, raceWithAbort } from "./abort.js";

export interface OtherFileDiagnostics {
  uri: string;
  errorCount: number;
  warningCount: number;
  topDiagnostics: Diagnostic[];
}

export type DiagnosticClassification = "new" | "pre-existing";

export interface ClassifiedDiagnostic {
  diagnostic: Diagnostic;
  classification: DiagnosticClassification;
}

export type DiagnosticDelta =
  | { hasBaseline: false }
  | {
    hasBaseline: true;
    diagnostics: ClassifiedDiagnostic[];
    fixedCount: number;
  };

export interface DiagnosticResult {
  status: "ok" | "timeout" | "unavailable";
  diagnostics: Diagnostic[];
  otherFiles: OtherFileDiagnostics[];
  retryAttempts: number;
  retryable?: boolean;
  delta?: DiagnosticDelta;
}

export interface LspClient {
  initialize(workspaceRoot: string): Promise<void>;
  didOpen(uri: string, languageId: string, content: string): void;
  didChange(uri: string, content: string): void;
  didClose(uri: string): void;
  waitForDiagnostics(
    uri: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticResult>;
  getAllDiagnostics(): Map<string, Diagnostic[]>;
  shutdown(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
const QUIESCENCE_MS = 200;
const MAX_DIAGNOSTICS_PER_OTHER_FILE = 3;

function countDiagnostics(diags: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error) errors++;
    else if (d.severity === DiagnosticSeverity.Warning) warnings++;
  }
  return { errors, warnings };
}

function diagnosticMessage(d: Diagnostic): string {
  return typeof d.message === "string" ? d.message : d.message.value;
}

function diagnosticFingerprint(d: Diagnostic): string {
  return `${d.severity}:${d.range.start.line}:${d.range.start.character}:${diagnosticMessage(d)}`;
}

function fingerprintSet(diags: Diagnostic[]): Set<string> {
  const set = new Set<string>();
  for (const d of diags) {
    if (d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Warning) {
      set.add(diagnosticFingerprint(d));
    }
  }
  return set;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function mergeDiagnostics(push: Diagnostic[], pull: Diagnostic[]): Diagnostic[] {
  const result = new Map<string, Diagnostic>();
  for (const diagnostic of [...push, ...pull]) {
    result.set(diagnosticFingerprint(diagnostic), diagnostic);
  }
  return [...result.values()];
}

export function createLspClient(child: ChildProcess): LspClient {
  if (!child.stdout || !child.stdin) {
    throw new Error("LSP child process must be spawned with stdio: pipe");
  }

  const connection = createProtocolConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  interface DiagnosticEntry {
    diagnostics: Diagnostic[];
    generation: number;
    pullDiagnostics: Diagnostic[];
    pushDiagnostics: Diagnostic[];
    pushRevision: number;
    received: boolean;
    validated: boolean;
    resultId?: string;
    resolve?: () => void;
  }

  interface PullDiagnosticSupport {
    identifier?: string;
    interFileDependencies: boolean;
  }

  class NonRetryablePullError extends Error {
    constructor(readonly cause: unknown) {
      super("diagnostic pull was cancelled without a retrigger request");
    }
  }

  const diagnosticsMap = new Map<string, DiagnosticEntry>();
  const documentVersion = new Map<string, number>();
  const uriGeneration = new Map<string, number>();
  let pullDiagnosticSupport: PullDiagnosticSupport | undefined;
  let crossFileCallback: ((changedUri: string) => void) | null = null;

  const diagnosticSnapshot = (targetUri: string): Map<string, Set<string>> => {
    const snapshot = new Map<string, Set<string>>();
    for (const [trackedUri, entry] of diagnosticsMap) {
      if (trackedUri !== targetUri) {
        snapshot.set(trackedUri, fingerprintSet(entry.diagnostics));
      }
    }
    return snapshot;
  };

  const collectOtherFiles = (
    targetUri: string,
    preSnapshot: Map<string, Set<string>>,
  ): OtherFileDiagnostics[] => {
    const result: OtherFileDiagnostics[] = [];
    for (const [trackedUri, entry] of diagnosticsMap) {
      if (trackedUri === targetUri) continue;
      const postFp = fingerprintSet(entry.diagnostics);
      const preFp = preSnapshot.get(trackedUri) ?? new Set();
      if (setsEqual(postFp, preFp)) continue;
      const post = countDiagnostics(entry.diagnostics);
      const errors = entry.diagnostics.filter(
        (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
      );
      const warnings = entry.diagnostics.filter(
        (diagnostic) => diagnostic.severity === DiagnosticSeverity.Warning,
      );
      result.push({
        uri: trackedUri,
        errorCount: post.errors,
        warningCount: post.warnings,
        topDiagnostics: [...errors, ...warnings].slice(0, MAX_DIAGNOSTICS_PER_OTHER_FILE),
      });
    }
    return result;
  };

  const applyPullReport = (
    uri: string,
    report: DocumentDiagnosticReport,
    expectedGenerations: Map<string, number>,
    expectedPushRevisions: Map<string, number>,
  ): void => {
    const currentGeneration = uriGeneration.get(uri) ?? 0;
    const expectedGeneration = expectedGenerations.get(uri) ?? 0;
    if (currentGeneration !== expectedGeneration) return;

    const existing = diagnosticsMap.get(uri);
    const entry: DiagnosticEntry = existing ?? {
      diagnostics: [],
      generation: currentGeneration,
      pullDiagnostics: [],
      pushDiagnostics: [],
      pushRevision: 0,
      received: false,
      validated: false,
    };

    if (report.kind === DocumentDiagnosticReportKind.Full) {
      if (entry.pushRevision === (expectedPushRevisions.get(uri) ?? 0)) {
        entry.pushDiagnostics = [];
      }
      entry.pullDiagnostics = report.items;
      entry.diagnostics = mergeDiagnostics(
        entry.pushDiagnostics,
        entry.pullDiagnostics,
      );
    }
    entry.generation = currentGeneration;
    entry.received = true;
    entry.validated = true;
    entry.resultId = report.resultId;
    diagnosticsMap.set(uri, entry);

    if (report.relatedDocuments) {
      for (const [relatedUri, relatedReport] of Object.entries(report.relatedDocuments)) {
        applyPullReport(
          relatedUri,
          relatedReport,
          expectedGenerations,
          expectedPushRevisions,
        );
      }
    }
  };

  const isRetriggerableCancellation = (error: unknown): boolean => {
    if (!(error instanceof ResponseError) || error.code !== LSPErrorCodes.ServerCancelled) {
      return false;
    }
    return !DiagnosticServerCancellationData.is(error.data) || error.data.retriggerRequest;
  };

  const pullDiagnostics = async (
    targetUri: string,
    timeoutMs: number,
    support: PullDiagnosticSupport,
    signal?: AbortSignal,
  ): Promise<DiagnosticResult> => {
    signal?.throwIfAborted();
    const preSnapshot = diagnosticSnapshot(targetUri);
    const expectedGenerations = new Map(uriGeneration);
    const expectedPushRevisions = new Map(
      [...diagnosticsMap].map(([uri, entry]) => [uri, entry.pushRevision]),
    );
    const uris = support.interFileDependencies
      ? [...documentVersion.keys()]
      : [targetUri];
    if (!uris.includes(targetUri)) uris.unshift(targetUri);

    const deadline = Date.now() + timeoutMs;
    const activeCancellations = new Set<CancellationTokenSource>();
    const requestController = new AbortController();
    const requestReport = async (uri: string): Promise<DocumentDiagnosticReport | undefined> => {
      const generation = expectedGenerations.get(uri) ?? 0;
      while (
        Date.now() < deadline &&
        documentVersion.has(uri) &&
        (uriGeneration.get(uri) ?? 0) === generation
      ) {
        signal?.throwIfAborted();
        const cancellation = new CancellationTokenSource();
        activeCancellations.add(cancellation);
        try {
          const previousResultId = diagnosticsMap.get(uri)?.resultId;
          return await raceWithAbort(
            connection.sendRequest(
              DocumentDiagnosticRequest.type,
              {
                textDocument: { uri },
                ...(support.identifier ? { identifier: support.identifier } : {}),
                ...(previousResultId ? { previousResultId } : {}),
              },
              cancellation.token,
            ),
            requestController.signal,
          );
        } catch (error) {
          signal?.throwIfAborted();
          if (requestController.signal.aborted) {
            throw abortReason(requestController.signal);
          }
          if (isRetriggerableCancellation(error)) continue;
          if (
            error instanceof ResponseError &&
            error.code === LSPErrorCodes.ServerCancelled
          ) {
            throw new NonRetryablePullError(error);
          }
          throw error;
        } finally {
          activeCancellations.delete(cancellation);
          cancellation.dispose();
        }
      }
      signal?.throwIfAborted();
      return undefined;
    };

    let acceptingReports = true;
    const cancelActiveRequests = (reason?: unknown) => {
      acceptingReports = false;
      if (!requestController.signal.aborted) {
        requestController.abort(
          reason ?? new DOMException("The diagnostic request stopped", "AbortError"),
        );
      }
      for (const cancellation of activeCancellations) cancellation.cancel();
    };
    const requests = uris.map(async (uri) => {
      try {
        const report = await requestReport(uri);
        if (report && acceptingReports) {
          applyPullReport(
            uri,
            report,
            expectedGenerations,
            expectedPushRevisions,
          );
        }
        return { report, uri };
      } catch (error) {
        return { error, report: undefined, uri };
      }
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let reports: Awaited<(typeof requests)[number]>[] | undefined;
    try {
      const abort = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        onAbort = () => {
          const reason = abortReason(signal);
          cancelActiveRequests(reason);
          reject(reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      reports = await Promise.race([
        Promise.all(requests),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), timeoutMs);
        }),
        abort,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }

    if (!reports) {
      cancelActiveRequests();
      return {
        status: "timeout",
        diagnostics: diagnosticsMap.get(targetUri)?.diagnostics ?? [],
        otherFiles: collectOtherFiles(targetUri, preSnapshot),
        retryAttempts: 0,
      };
    }

    try {
      await abortableDelay(QUIESCENCE_MS, signal);
    } finally {
      acceptingReports = false;
    }

    const target = reports.find(({ uri }) => uri === targetUri);
    const nonRetryable = reports.some(
      ({ error }) => error instanceof NonRetryablePullError,
    );
    if (target?.error && !target.report && !nonRetryable) throw target.error;
    const incomplete = reports.some(({ error, report }) => error !== undefined || !report);
    return {
      status: target?.report && !incomplete ? "ok" : "timeout",
      diagnostics: diagnosticsMap.get(targetUri)?.diagnostics ?? [],
      otherFiles: collectOtherFiles(targetUri, preSnapshot),
      retryAttempts: 0,
      ...(nonRetryable ? { retryable: false } : {}),
    };
  };

  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    const entry = diagnosticsMap.get(params.uri);
    if (entry) {
      const currentGen = uriGeneration.get(params.uri) ?? 0;
      if (entry.generation !== currentGen) return;
      entry.pushDiagnostics = params.diagnostics;
      entry.pushRevision += 1;
      entry.diagnostics = mergeDiagnostics(
        entry.pushDiagnostics,
        entry.pullDiagnostics,
      );
      entry.received = true;
      entry.validated = true;
      entry.resolve?.();
    } else {
      const gen = uriGeneration.get(params.uri) ?? 0;
      diagnosticsMap.set(params.uri, {
        diagnostics: params.diagnostics,
        generation: gen,
        pullDiagnostics: [],
        pushDiagnostics: params.diagnostics,
        pushRevision: 1,
        received: true,
        validated: true,
      });
    }
    if (crossFileCallback) crossFileCallback(params.uri);
  });

  connection.listen();

  return {
    async initialize(workspaceRoot: string) {
      const params: InitializeParams = {
        processId: child.pid ?? null,
        rootUri: fileUri(workspaceRoot),
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false,
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
            diagnostic: {
              dynamicRegistration: false,
              relatedDocumentSupport: true,
            },
          },
        },
        workspaceFolders: [{ uri: fileUri(workspaceRoot), name: "workspace" }],
      };

      const result = await connection.sendRequest(InitializeRequest.type, params);
      const diagnosticProvider = result.capabilities.diagnosticProvider;
      if (diagnosticProvider) {
        pullDiagnosticSupport = {
          identifier: diagnosticProvider.identifier,
          interFileDependencies: diagnosticProvider.interFileDependencies,
        };
      }
      connection.sendNotification(InitializedNotification.type, {});
    },

    didOpen(uri: string, languageId: string, content: string) {
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      documentVersion.set(uri, 1);
      diagnosticsMap.set(uri, {
        diagnostics: [],
        generation: gen,
        pullDiagnostics: [],
        pushDiagnostics: [],
        pushRevision: 0,
        received: false,
        validated: false,
      });
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text: content },
      });
    },

    didChange(uri: string, content: string) {
      const version = (documentVersion.get(uri) ?? 1) + 1;
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      const previous = diagnosticsMap.get(uri);
      uriGeneration.set(uri, gen);
      documentVersion.set(uri, version);
      diagnosticsMap.set(uri, {
        diagnostics: previous?.diagnostics ?? [],
        generation: gen,
        pullDiagnostics: previous?.pullDiagnostics ?? [],
        pushDiagnostics: previous?.pushDiagnostics ?? [],
        pushRevision: previous?.pushRevision ?? 0,
        received: false,
        validated: previous?.validated ?? false,
        ...(previous?.resultId ? { resultId: previous.resultId } : {}),
      });
      connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    },

    didClose(uri: string) {
      const gen = (uriGeneration.get(uri) ?? 0) + 1;
      uriGeneration.set(uri, gen);
      connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
      diagnosticsMap.delete(uri);
      documentVersion.delete(uri);
    },

    async waitForDiagnostics(
      uri: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<DiagnosticResult> {
      signal?.throwIfAborted();
      if (pullDiagnosticSupport) {
        return pullDiagnostics(uri, timeoutMs, pullDiagnosticSupport, signal);
      }

      const targetGen = uriGeneration.get(uri) ?? 0;
      const preSnapshot = diagnosticSnapshot(uri);

      return new Promise<DiagnosticResult>((resolve, reject) => {
        let settled = false;
        let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
        let entryResolve: (() => void) | undefined;
        let onCrossFile: ((changedUri: string) => void) | undefined;

        const cleanup = () => {
          clearTimeout(timeout);
          if (quiescenceTimer) clearTimeout(quiescenceTimer);
          signal?.removeEventListener("abort", onAbort);
          const current = diagnosticsMap.get(uri);
          if (current && current.resolve === entryResolve) {
            current.resolve = undefined;
          }
          if (crossFileCallback === onCrossFile) crossFileCallback = null;
        };

        const settle = (status: "ok" | "timeout") => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            status,
            diagnostics: diagnosticsMap.get(uri)?.diagnostics ?? [],
            otherFiles: collectOtherFiles(uri, preSnapshot),
            retryAttempts: 0,
            ...(status === "timeout" && diagnosticsMap.get(uri)?.validated
              ? { retryable: false }
              : {}),
          });
        };

        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(abortReason(signal!));
        };

        const resetQuiescence = () => {
          if (settled) return;
          if (quiescenceTimer) clearTimeout(quiescenceTimer);
          quiescenceTimer = setTimeout(() => settle("ok"), QUIESCENCE_MS);
        };

        const timeout = setTimeout(() => settle("timeout"), timeoutMs);
        const entry = diagnosticsMap.get(uri) ?? {
          diagnostics: [],
          generation: targetGen,
          pullDiagnostics: [],
          pushDiagnostics: [],
          pushRevision: 0,
          received: false,
          validated: false,
        };

        entryResolve = () => {
          clearTimeout(timeout);
          resetQuiescence();
        };
        entry.resolve = entryResolve;
        diagnosticsMap.set(uri, entry);

        onCrossFile = (changedUri: string) => {
          if (settled || changedUri === uri) return;
          const preFp = preSnapshot.get(changedUri) ?? new Set<string>();
          const postFp = fingerprintSet(diagnosticsMap.get(changedUri)?.diagnostics ?? []);
          if (!setsEqual(preFp, postFp)) {
            clearTimeout(timeout);
            resetQuiescence();
          }
        };
        crossFileCallback = onCrossFile;

        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
        } else if (entry.received) {
          clearTimeout(timeout);
          resetQuiescence();
        }
      });
    },

    getAllDiagnostics(): Map<string, Diagnostic[]> {
      const result = new Map<string, Diagnostic[]>();
      for (const [uri, entry] of diagnosticsMap) {
        if (entry.diagnostics.length > 0) {
          result.set(uri, [...entry.diagnostics]);
        }
      }
      return result;
    },

    async shutdown() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          connection.sendRequest(ShutdownRequest.type),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("shutdown timed out")), SHUTDOWN_TIMEOUT_MS);
          }),
        ]);
        await connection.sendNotification(ExitNotification.type);
      } catch {
        // timed out or server already exited
      } finally {
        if (timer) clearTimeout(timer);
      }
      connection.dispose();
    },
  };
}
