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
  DiagnosticSeverity,
  DocumentDiagnosticReportKind,
  DocumentDiagnosticRequest,
  LSPErrorCodes,
  ResponseError,
  type Diagnostic,
  type DocumentDiagnosticReport,
  type FullDocumentDiagnosticReport,
  type InitializeResult,
  type TextDocumentSyncKind,
} from "vscode-languageserver-protocol/node";

export interface FakeServerOptions {
  diagnosticDelay?: number;
  diagnosticsByUri?: Map<string, Diagnostic[]>;
  otherFileDiagnostics?: Map<string, Diagnostic[]>;
  crashOnInit?: boolean;
  neverPublish?: boolean;
  neverShutdown?: boolean;
  publishOnlyOnce?: boolean;
  publishOnAttempt?: number;
  pullCancelAttempts?: number;
  pullCancelRetrigger?: boolean;
  pullCancelWithoutData?: boolean;
  pullDelay?: number;
  pullDiagnostics?: boolean;
  pullUnchangedAfterFirst?: boolean;
  neverPullUris?: string[];
  pushAfterPullDelay?: number;
  pushAfterPullDiagnostics?: Map<string, Diagnostic[]>;
  pushAfterPullOnlyOnce?: boolean;
}

const defaultDiagnostic: Diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  severity: DiagnosticSeverity.Error,
  message: "fake error",
  source: "fake",
};

export function startFakeServer(options: FakeServerOptions = {}) {
  const delay = options.diagnosticDelay ?? 0;
  const crashOnInit = options.crashOnInit ?? false;
  const neverPublish = options.neverPublish ?? false;
  const neverShutdown = options.neverShutdown ?? false;
  const publishOnlyOnce = options.publishOnlyOnce ?? false;
  const publishOnAttempt = options.publishOnAttempt ?? 1;
  const pullCancelAttempts = options.pullCancelAttempts ?? 0;
  const pullCancelRetrigger = options.pullCancelRetrigger ?? true;
  const pullCancelWithoutData = options.pullCancelWithoutData ?? false;
  const pullDelay = options.pullDelay ?? 0;
  const pullDiagnostics = options.pullDiagnostics ?? false;
  const pullUnchangedAfterFirst = options.pullUnchangedAfterFirst ?? false;
  const neverPullUris = new Set(options.neverPullUris ?? []);
  const pushAfterPullDelay = options.pushAfterPullDelay ?? 0;
  const pushAfterPullOnlyOnce = options.pushAfterPullOnlyOnce ?? false;
  const attemptCounts = new Map<string, number>();
  const pullCounts = new Map<string, number>();

  const connection = createProtocolConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );

  connection.onRequest(InitializeRequest.type, (_params) => {
    if (crashOnInit) {
      process.exit(1);
    }
    const result: InitializeResult = {
      capabilities: {
        textDocumentSync: 1 as TextDocumentSyncKind,
        diagnosticProvider: pullDiagnostics
          ? {
              identifier: "fake",
              interFileDependencies: true,
              workspaceDiagnostics: false,
            }
          : undefined,
      },
    };
    return result;
  });

  connection.onNotification(InitializedNotification.type, () => {});

  function publishDiagnostics(uri: string) {
    if (neverPublish || pullDiagnostics) return;

    const count = (attemptCounts.get(uri) ?? 0) + 1;
    attemptCounts.set(uri, count);

    if (count < publishOnAttempt || (publishOnlyOnce && count > 1)) return;

    const diags = options.diagnosticsByUri?.get(uri) ?? [defaultDiagnostic];

    const publish = () => {
      connection.sendNotification(PublishDiagnosticsNotification.type, {
        uri,
        diagnostics: diags,
      });

      if (options.otherFileDiagnostics) {
        for (const [otherUri, otherDiags] of options.otherFileDiagnostics) {
          if (otherUri === uri) continue;
          connection.sendNotification(PublishDiagnosticsNotification.type, {
            uri: otherUri,
            diagnostics: otherDiags,
          });
        }
      }
    };

    if (delay > 0) {
      setTimeout(publish, delay);
    } else {
      publish();
    }
  }

  connection.onNotification(DidOpenTextDocumentNotification.type, (params) => {
    publishDiagnostics(params.textDocument.uri);
  });

  connection.onNotification(DidChangeTextDocumentNotification.type, (params) => {
    publishDiagnostics(params.textDocument.uri);
  });

  connection.onNotification(DidCloseTextDocumentNotification.type, () => {});

  connection.onRequest(
    DocumentDiagnosticRequest.type,
    async (params): Promise<DocumentDiagnosticReport> => {
      const count = (pullCounts.get(params.textDocument.uri) ?? 0) + 1;
      pullCounts.set(params.textDocument.uri, count);
      if (count <= pullCancelAttempts) {
        throw new ResponseError(
          LSPErrorCodes.ServerCancelled,
          "retry pull",
          pullCancelWithoutData
            ? undefined
            : { retriggerRequest: pullCancelRetrigger },
        );
      }
      if (neverPullUris.has(params.textDocument.uri)) {
        return new Promise<DocumentDiagnosticReport>(() => {});
      }
      if (pullDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, pullDelay));
      }
      if (pullUnchangedAfterFirst && count > 1 && params.previousResultId) {
        return {
          kind: DocumentDiagnosticReportKind.Unchanged,
          resultId: params.previousResultId,
        };
      }
      if (
        options.pushAfterPullDiagnostics &&
        (!pushAfterPullOnlyOnce || count === 1)
      ) {
        setTimeout(() => {
          for (const [uri, diagnostics] of options.pushAfterPullDiagnostics ?? []) {
            connection.sendNotification(PublishDiagnosticsNotification.type, {
              diagnostics,
              uri,
            });
          }
        }, pushAfterPullDelay);
      }
      const relatedDocuments = options.otherFileDiagnostics
        ? Object.fromEntries(
            [...options.otherFileDiagnostics]
              .filter(([uri]) => uri !== params.textDocument.uri)
              .map(([uri, items]) => [
                uri,
                {
                  items,
                  kind: DocumentDiagnosticReportKind.Full,
                  resultId: `related-${count}`,
                } satisfies FullDocumentDiagnosticReport,
              ]),
          )
        : undefined;
      return {
        items: options.diagnosticsByUri?.get(params.textDocument.uri) ?? [defaultDiagnostic],
        kind: DocumentDiagnosticReportKind.Full,
        resultId: String(count),
        ...(relatedDocuments ? { relatedDocuments } : {}),
      };
    },
  );

  connection.onRequest(ShutdownRequest.type, () => {
    if (neverShutdown) return new Promise<void>(() => {});
    return undefined;
  });
  connection.onNotification(ExitNotification.type, () => {
    process.exit(0);
  });

  connection.listen();
}

if (process.argv.includes("--run")) {
  const optionsJson = process.argv.find((a) => a.startsWith("--options="));
  let options: FakeServerOptions = {};
  if (optionsJson) {
    const raw = JSON.parse(optionsJson.slice("--options=".length));
    if (raw.diagnosticDelay) options.diagnosticDelay = raw.diagnosticDelay;
    if (raw.crashOnInit) options.crashOnInit = raw.crashOnInit;
    if (raw.neverPublish) options.neverPublish = raw.neverPublish;
    if (raw.neverShutdown) options.neverShutdown = raw.neverShutdown;
    if (raw.publishOnlyOnce) options.publishOnlyOnce = raw.publishOnlyOnce;
    if (raw.publishOnAttempt !== undefined) options.publishOnAttempt = raw.publishOnAttempt;
    if (raw.pullCancelAttempts !== undefined) options.pullCancelAttempts = raw.pullCancelAttempts;
    if (raw.pullCancelRetrigger !== undefined) options.pullCancelRetrigger = raw.pullCancelRetrigger;
    if (raw.pullCancelWithoutData) options.pullCancelWithoutData = raw.pullCancelWithoutData;
    if (raw.pullDelay !== undefined) options.pullDelay = raw.pullDelay;
    if (raw.pullDiagnostics) options.pullDiagnostics = raw.pullDiagnostics;
    if (raw.pullUnchangedAfterFirst) options.pullUnchangedAfterFirst = raw.pullUnchangedAfterFirst;
    if (raw.neverPullUris) options.neverPullUris = raw.neverPullUris;
    if (raw.pushAfterPullDelay !== undefined) options.pushAfterPullDelay = raw.pushAfterPullDelay;
    if (raw.pushAfterPullOnlyOnce) options.pushAfterPullOnlyOnce = raw.pushAfterPullOnlyOnce;
    if (raw.pushAfterPullDiagnostics) {
      options.pushAfterPullDiagnostics = new Map(Object.entries(raw.pushAfterPullDiagnostics));
    }
    if (raw.diagnosticsByUri) {
      options.diagnosticsByUri = new Map(Object.entries(raw.diagnosticsByUri));
    }
    if (raw.otherFileDiagnostics) {
      options.otherFileDiagnostics = new Map(Object.entries(raw.otherFileDiagnostics));
    }
  }
  startFakeServer(options);
}
