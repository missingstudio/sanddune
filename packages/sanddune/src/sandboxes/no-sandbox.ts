import type { NoSandboxProvider } from "../core";

export interface NoSandboxOptions {
  readonly env?: Readonly<Record<string, string>>;
}

/** **No-sandbox provider** — runs the **agent** directly on the **host**.
 *  Accepted only by `interactive()` / `wt.interactive()`; the type system
 *  rejects it for `run()` and `createSandbox()` (CONTEXT.md).
 *
 *  The provider carries no factory method because there is no container to
 *  create — the orchestrator special-cases `kind === "no-sandbox"` and
 *  spawns the agent process on the host filesystem. */
export function noSandbox(options?: NoSandboxOptions): NoSandboxProvider {
  return {
    kind: "no-sandbox",
    name: "no-sandbox",
    ...(options?.env !== undefined && { env: options.env }),
  };
}
