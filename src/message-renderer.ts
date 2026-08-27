export interface DiagnosticMessageTheme {
  fg(color: "dim" | "error" | "warning", text: string): string;
}

export interface DiagnosticMessageInput {
  content?: unknown;
  details?: unknown;
}

function messageFilePath(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const filePath = (details as { filePath?: unknown }).filePath;
  return typeof filePath === "string" && filePath.length > 0
    ? filePath
    : undefined;
}

function styleHeader(
  line: string,
  filePath: string | undefined,
  theme: DiagnosticMessageTheme,
): string | undefined {
  if (filePath) {
    const index = line.indexOf(filePath);
    if (index >= 0) {
      return `${line.slice(0, index)}${theme.fg("dim", filePath)}${line.slice(index + filePath.length)}`;
    }
  }

  const match = /^(⚠ LSP diagnostics (?:unavailable )?for )(.+?)( \(|: no issues|$)(.*)$/u.exec(line);
  if (!match) return undefined;
  return `${match[1]}${theme.fg("dim", match[2])}${match[3]}${match[4]}`;
}

function styleLine(
  line: string,
  filePath: string | undefined,
  theme: DiagnosticMessageTheme,
): string {
  const diagnostic = /^(\s*)(.+)(:\d+:\d+: )(error|warning)(.*)$/u.exec(line);
  if (diagnostic) {
    const color = diagnostic[4] === "error" ? "error" : "warning";
    return `${diagnostic[1]}${theme.fg("dim", diagnostic[2])}${diagnostic[3]}${theme.fg(color, diagnostic[4] + diagnostic[5])}`;
  }

  const related = /^(\s*↳\s+)(.+)(:\d+:\d+:.*)$/u.exec(line);
  if (related) {
    return `${related[1]}${theme.fg("dim", related[2])}${related[3]}`;
  }

  return styleHeader(line, filePath, theme) ?? line;
}

function messageContent(message: DiagnosticMessageInput): string {
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  const filePath = messageFilePath(message.details);
  return filePath
    ? `⚠ LSP diagnostics for ${filePath}`
    : "⚠ LSP diagnostics";
}

function collapsedLines(lines: string[]): { lines: string[]; omitted: number } {
  if (lines.length <= 2) return { lines, omitted: 0 };

  const selected = new Set([0]);
  const firstDiagnostic = lines.findIndex((line) =>
    /:\d+:\d+: (?:error|warning)/u.test(line)
  );
  if (firstDiagnostic >= 0) selected.add(firstDiagnostic);

  return {
    lines: lines.filter((_line, index) => selected.has(index)),
    omitted: lines.length - selected.size,
  };
}

export function renderDiagnosticMessage(
  message: DiagnosticMessageInput,
  expanded: boolean,
  theme: DiagnosticMessageTheme,
): string {
  const allLines = messageContent(message).split(/\r?\n/u);
  const visible = expanded
    ? { lines: allLines, omitted: 0 }
    : collapsedLines(allLines);
  const filePath = messageFilePath(message.details);
  const rendered = visible.lines.map((line) =>
    styleLine(line, filePath, theme)
  );

  if (visible.omitted > 0) {
    const noun = visible.omitted === 1 ? "line" : "lines";
    rendered.push(theme.fg("dim", `  … ${visible.omitted} more ${noun}`));
  }
  return rendered.join("\n");
}
