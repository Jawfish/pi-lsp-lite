import type {
  EditDiagnosticResult,
  ServerManager,
} from "../src/server-manager.js";

export async function handleInitial(
  manager: ServerManager,
  ...args: Parameters<ServerManager["handleEdit"]>
): Promise<EditDiagnosticResult> {
  return (await manager.handleEdit(...args)).initial;
}
