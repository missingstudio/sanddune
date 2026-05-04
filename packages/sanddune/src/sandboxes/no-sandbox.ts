import type { NoSandboxProvider } from "../core";

export interface NoSandboxOptions {
  readonly env?: Readonly<Record<string, string>>;
}

/** No factory because there is no container — the orchestrator special-cases
 *  `kind === "no-sandbox"` and spawns the agent on the host. */
export function noSandbox(options?: NoSandboxOptions): NoSandboxProvider {
  return {
    kind: "no-sandbox",
    name: "no-sandbox",
    ...(options?.env !== undefined && { env: options.env }),
  };
}
