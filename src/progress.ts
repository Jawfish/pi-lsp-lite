export interface ValidationProgress {
  phase: "start" | "end";
  serverId: string;
  root: string;
  attempt: number;
  totalAttempts: number;
}

export interface WorkingMessageController {
  handle(event: ValidationProgress): void;
  reset(): void;
}

function validationKey(event: ValidationProgress): string {
  return JSON.stringify([event.serverId, event.root]);
}

function formatValidation(event: ValidationProgress): string {
  return `${event.serverId} validating (attempt ${event.attempt}/${event.totalAttempts})`;
}

export function createWorkingMessageController(
  setWorkingMessage: (message?: string) => void,
): WorkingMessageController {
  const active = new Map<string, ValidationProgress>();
  let ownsWorkingMessage = false;

  function update(): void {
    const validations = [...active.values()];
    if (validations.length > 0) {
      const concurrent = validations.length > 1
        ? ` +${validations.length - 1} more`
        : "";
      setWorkingMessage(`lsp: ${formatValidation(validations[0])}${concurrent}`);
      ownsWorkingMessage = true;
      return;
    }

    if (ownsWorkingMessage) {
      setWorkingMessage();
      ownsWorkingMessage = false;
    }
  }

  return {
    handle(event): void {
      const key = validationKey(event);
      if (event.phase === "start") {
        active.set(key, event);
      } else {
        const current = active.get(key);
        if (!current || current.attempt !== event.attempt) return;
        active.delete(key);
      }
      update();
    },

    reset(): void {
      active.clear();
      update();
    },
  };
}
