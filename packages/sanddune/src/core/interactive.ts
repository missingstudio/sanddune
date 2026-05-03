import type { AgentProvider } from "./agent-provider";
import type { SandboxHooks } from "./hooks";
import type { OptionalPromptOption } from "./prompt";
import type { InteractiveSandboxProvider } from "./sandbox-provider";
import type { Timeouts } from "./timeouts";

export type InteractiveOptions<
  S extends InteractiveSandboxProvider = InteractiveSandboxProvider,
> = OptionalPromptOption & {
  readonly agent: AgentProvider;
  readonly sandbox: S;
  readonly cwd?: string;
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly copyToWorktree?: readonly string[];
  readonly signal?: AbortSignal;
};
