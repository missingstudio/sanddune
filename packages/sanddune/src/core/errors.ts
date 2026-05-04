export class NotImplementedError extends Error {
  readonly _tag = "NotImplementedError" as const;

  constructor(symbol: string) {
    super(`${symbol} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/** Raised when an iteration produces no agent stream event for
 *  idleTimeoutSeconds. Surfaces verbatim as the run rejection reason. */
export class AgentIdleTimeoutError extends Error {
  readonly _tag = "AgentIdleTimeoutError" as const;
  readonly idleTimeoutSeconds: number;
  readonly iteration: number;

  constructor(params: { idleTimeoutSeconds: number; iteration: number }) {
    super(
      `Agent produced no output for ${params.idleTimeoutSeconds}s on iteration ${params.iteration}`,
    );
    this.name = "AgentIdleTimeoutError";
    this.idleTimeoutSeconds = params.idleTimeoutSeconds;
    this.iteration = params.iteration;
  }
}

export class HookTimeoutError extends Error {
  readonly _tag = "HookTimeoutError" as const;
  readonly command: string;
  readonly timeoutMs: number;

  constructor(params: { command: string; timeoutMs: number }) {
    super(
      `Hook timed out after ${params.timeoutMs}ms: ${params.command}`,
    );
    this.name = "HookTimeoutError";
    this.command = params.command;
    this.timeoutMs = params.timeoutMs;
  }
}

export class CopyToWorktreeTimeoutError extends Error {
  readonly _tag = "CopyToWorktreeTimeoutError" as const;
  readonly timeoutMs: number;
  readonly currentItem: string;

  constructor(params: { timeoutMs: number; currentItem: string }) {
    super(
      `copyToWorktree timed out after ${params.timeoutMs}ms while copying ${params.currentItem}`,
    );
    this.name = "CopyToWorktreeTimeoutError";
    this.timeoutMs = params.timeoutMs;
    this.currentItem = params.currentItem;
  }
}
