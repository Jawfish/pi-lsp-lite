import type { DiagnosticResult } from "./client.js";

export interface DiagnosticNotification {
  message: string;
  type: "warning";
}

export function diagnosticNotification(
  status: DiagnosticResult["status"],
  formatted: string,
): DiagnosticNotification | undefined {
  if (status !== "unavailable") return undefined;
  return { message: formatted.trim(), type: "warning" };
}
