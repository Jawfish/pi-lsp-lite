import type {
  EditDiagnosticResult,
  ServerManager,
} from "../src/server-manager.js";

export async function handleInitial(
  manager: ServerManager,
  ...args: Parameters<ServerManager["handleEdit"]>
): Promise<EditDiagnosticResult> {
  const outcome = await manager.handleEdit(...args);
  if (outcome.superseded) {
    throw new Error("Unexpected superseded edit in test");
  }
  return outcome.initial;
}
