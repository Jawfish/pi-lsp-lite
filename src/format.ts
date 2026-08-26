import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative } from "node:path";
import type { DiagnosticResult } from "./client.js";

const MAX_DIAGNOSTICS_PER_FILE = 50;
const MAX_RELATED_INFORMATION = 2;
const MAX_SOURCE_EXCERPTS = 5;
const MAX_SOURCE_EXCERPT_LENGTH = 120;

function diagnosticSeverityName(severity: Diagnostic["severity"]): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warning";
    case DiagnosticSeverity.Information:
      return "info";
    case DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "diagnostic";
  }
}

function displayPath(filePath: string, cwd?: string): string {
  return cwd && isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
}

function displayUri(uri: string, cwd?: string): string {
  try {
    return displayPath(fileURLToPath(uri), cwd);
  } catch {
    return uri;
  }
}

export function formatDiagnosticLine(filePath: string, diagnostic: Diagnostic, cwd?: string): string {
  const path = displayPath(filePath, cwd);
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  const severity = diagnosticSeverityName(diagnostic.severity);
  const code = diagnostic.code === undefined ? "" : `[${String(diagnostic.code)}]`;
  const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
  return `  ${path}:${line}:${col}: ${severity}${code}: ${diagnostic.message}${source}`;
}

export function formatDiagnostic(
  filePath: string,
  diagnostic: Diagnostic,
  cwd?: string,
  sourceExcerpt?: string,
): string[] {
  const lines = [formatDiagnosticLine(filePath, diagnostic, cwd)];
  if (sourceExcerpt !== undefined) lines.push(`    | ${sourceExcerpt}`);
  for (const related of diagnostic.relatedInformation?.slice(0, MAX_RELATED_INFORMATION) ?? []) {
    const path = displayUri(related.location.uri, cwd);
    const line = related.location.range.start.line + 1;
    const col = related.location.range.start.character + 1;
    lines.push(`    ↳ ${path}:${line}:${col}: ${related.message}`);
  }
  return lines;
}

function sourceExcerpt(sourceLines: string[] | undefined, line: number): string | undefined {
  if (!sourceLines || line < 0 || line >= sourceLines.length) return undefined;
  const trimmed = sourceLines[line].trim();
  if (trimmed.length <= MAX_SOURCE_EXCERPT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_SOURCE_EXCERPT_LENGTH - 3)}...`;
}

export function formatDiagnostics(
  filePath: string,
  result: DiagnosticResult,
  cwd?: string,
  documentContent?: string,
): string {
  const delta = result.delta?.hasBaseline === true ? result.delta : undefined;
  const classified = delta?.diagnostics.filter(
    ({ diagnostic }) =>
      diagnostic.severity === DiagnosticSeverity.Error ||
      diagnostic.severity === DiagnosticSeverity.Warning,
  );
  const allRelevant = classified?.map(({ diagnostic }) => diagnostic) ??
    result.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === DiagnosticSeverity.Error ||
        diagnostic.severity === DiagnosticSeverity.Warning,
    );

  if (
    allRelevant.length === 0 &&
    result.status === "ok" &&
    result.otherFiles.length === 0 &&
    (delta?.fixedCount ?? 0) === 0
  ) return "";

  if (result.status === "unavailable") {
    return `\n⚠ LSP diagnostics unavailable for ${filePath} (server missing or failed to start)`;
  }

  const orderedClassified = classified
    ? [
      ...classified.filter(({ classification }) => classification === "new"),
      ...classified.filter(({ classification }) => classification === "pre-existing"),
    ]
    : undefined;
  const orderedDiagnostics = orderedClassified?.map(({ diagnostic }) => diagnostic) ?? allRelevant;
  const truncated = orderedDiagnostics.length > MAX_DIAGNOSTICS_PER_FILE;
  const relevant = truncated
    ? orderedDiagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)
    : orderedDiagnostics;

  const retryNote = result.status === "timeout" && result.retryAttempts > 0
    ? ` after ${result.retryAttempts} ${result.retryAttempts === 1 ? "retry" : "retries"}`
    : "";

  if (!delta && relevant.length === 0 && result.status === "ok" && result.otherFiles.length > 0) {
    return `\n⚠ LSP diagnostics for ${filePath}: no issues${otherFilesFooter(result, cwd)}`;
  }

  const sourceLines = documentContent?.split(/\r?\n/u);
  let excerptCount = 0;
  const renderDiagnostic = (diagnostic: Diagnostic): string[] => {
    const excerpt = excerptCount < MAX_SOURCE_EXCERPTS
      ? sourceExcerpt(sourceLines, diagnostic.range.start.line)
      : undefined;
    excerptCount++;
    return formatDiagnostic(filePath, diagnostic, cwd, excerpt);
  };

  const lines: string[] = [];
  if (orderedClassified) {
    const displayed = truncated
      ? orderedClassified.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      : orderedClassified;
    const newDiagnostics = displayed.filter(
      ({ classification }) => classification === "new",
    );
    const preExistingDiagnostics = displayed.filter(
      ({ classification }) => classification === "pre-existing",
    );
    lines.push(...newDiagnostics.flatMap(({ diagnostic }) => renderDiagnostic(diagnostic)));
    if (preExistingDiagnostics.length > 0) {
      lines.push("  pre-existing:");
      lines.push(...preExistingDiagnostics.flatMap(({ diagnostic }) => renderDiagnostic(diagnostic)));
    }
  } else {
    lines.push(...relevant.flatMap(renderDiagnostic));
  }

  let errorCount = 0;
  for (const diagnostic of allRelevant) {
    if (diagnostic.severity === DiagnosticSeverity.Error) errorCount++;
  }
  const warnCount = allRelevant.length - errorCount;
  const newCount = classified?.filter(
    ({ classification }) => classification === "new",
  ).length ?? 0;
  const preExistingCount = (classified?.length ?? 0) - newCount;

  const summary = [
    ...(delta
      ? [
        `${newCount} new`,
        `${preExistingCount} pre-existing`,
        `${delta.fixedCount} fixed`,
      ]
      : [
        errorCount > 0 ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : "",
        warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? "s" : ""}` : "",
      ]),
    result.status === "timeout" ? `timed out${retryNote}, may be incomplete` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const diagnosticBlock = lines.length > 0 ? `:\n${lines.join("\n")}` : "";
  const truncatedNote = truncated ? `\n  ... and ${allRelevant.length - MAX_DIAGNOSTICS_PER_FILE} more` : "";

  return `\n⚠ LSP diagnostics for ${filePath} (${summary})${diagnosticBlock}${truncatedNote}${otherFilesFooter(result, cwd)}`;
}

function otherFilesFooter(result: DiagnosticResult, cwd?: string): string {
  if (result.otherFiles.length === 0) return "";
  const lines = result.otherFiles.map((f) => {
    let path: string;
    try {
      const abs = fileURLToPath(f.uri);
      path = cwd ? relative(cwd, abs) : abs;
    } catch {
      path = f.uri;
    }
    const counts = [
      f.errorCount > 0 ? `${f.errorCount} error${f.errorCount > 1 ? "s" : ""}` : "",
      f.warningCount > 0 ? `${f.warningCount} warning${f.warningCount > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(", ");
    const diagnostics = f.topDiagnostics.slice(0, 3);
    const header = `  ${path} (${counts})${diagnostics.length > 0 ? ":" : ""}`;
    const diagnosticLines = diagnostics.flatMap((diagnostic) =>
      formatDiagnostic(path, diagnostic, cwd)
    );
    return [header, ...diagnosticLines].join("\n");
  });
  return `\n${lines.join("\n")}`;
}
