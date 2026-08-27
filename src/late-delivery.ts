import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type {
  EditDiagnosticOutcome,
  EditDiagnosticResult,
} from "./server-manager.js";
import { formatDiagnostics } from "./format.js";

export const LSP_DIAGNOSTICS_MESSAGE_TYPE = "lsp-lite-diagnostics";

export interface LspDiagnosticsMessage {
  customType: typeof LSP_DIAGNOSTICS_MESSAGE_TYPE;
  content: string;
  display: true;
  details: { filePath: string };
}

export type SendLspDiagnosticsMessage = (
  message: LspDiagnosticsMessage,
  options: { deliverAs: "steer" },
) => void;

function isRelevant(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === DiagnosticSeverity.Error ||
    diagnostic.severity === DiagnosticSeverity.Warning;
}

function diagnosticFingerprint(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.severity ?? null,
    diagnostic.source ?? null,
    diagnostic.code ?? null,
    diagnostic.message,
    diagnostic.range,
  ]);
}

export function resultFingerprint(result: EditDiagnosticResult): string {
  const target = result.diagnostics
    .filter(isRelevant)
    .map(diagnosticFingerprint)
    .sort();
  const otherFiles = result.otherFiles
    .map((otherFile) => [
      otherFile.uri,
      otherFile.errorCount,
      otherFile.warningCount,
      otherFile.topDiagnostics
        .filter(isRelevant)
        .map(diagnosticFingerprint)
        .sort(),
    ])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));

  return JSON.stringify({ target, otherFiles });
}

export interface LateDeliveryOptions {
  cwd: string;
  filePath: string;
  outcome: EditDiagnosticOutcome;
  sendMessage: SendLspDiagnosticsMessage;
  signal?: AbortSignal;
}

export async function deliverLateDiagnostics({
  cwd,
  filePath,
  outcome,
  sendMessage,
  signal,
}: LateDeliveryOptions): Promise<void> {
  if (outcome.superseded || !outcome.pending) return;
  const final = await outcome.pending;
  if (signal?.aborted || !final) return;
  if (resultFingerprint(outcome.initial) === resultFingerprint(final)) return;

  const content = formatDiagnostics(
    filePath,
    final,
    cwd,
    final.documentContent,
  ) || `\n⚠ LSP diagnostics for ${filePath}: no issues`;

  sendMessage(
    {
      customType: LSP_DIAGNOSTICS_MESSAGE_TYPE,
      content,
      display: true,
      details: { filePath },
    },
    { deliverAs: "steer" },
  );
}
