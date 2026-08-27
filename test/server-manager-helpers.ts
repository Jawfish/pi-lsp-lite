import type {
  EditDiagnosticResult,
  ServerManager,
} from "../src/server-manager.js";

function assertCurrent(outcome: { superseded?: boolean }): void {
  if (outcome.superseded) {
    throw new Error("Unexpected superseded edit in test");
  }
}

export async function handleInitial(
  manager: ServerManager,
  ...args: Parameters<ServerManager["handleEdit"]>
): Promise<EditDiagnosticResult> {
  const outcome = await manager.handleEdit(...args);
  assertCurrent(outcome);
  return outcome.initial;
}

export async function handleFinal(
  manager: ServerManager,
  ...args: Parameters<ServerManager["handleEdit"]>
): Promise<EditDiagnosticResult> {
  const outcome = await manager.handleEdit(...args);
  assertCurrent(outcome);
  return (await outcome.pending) ?? outcome.initial;
}
