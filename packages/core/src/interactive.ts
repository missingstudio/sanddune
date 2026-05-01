import type { AgentProvider } from "./agent-provider";
import type { SandboxHooks } from "./hooks";
import type { PromptOption } from "./prompt";
import type { InteractiveSandboxProvider } from "./sandbox-provider";
import type { Timeouts } from "./timeouts";
import type { CopyToWorktree } from "./run";

export type InteractiveOptions<
  S extends InteractiveSandboxProvider = InteractiveSandboxProvider,
> = PromptOption & {
  readonly agent: AgentProvider;
  readonly sandbox: S;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly hooks?: SandboxHooks;
  readonly timeouts?: Timeouts;
  readonly copyToWorktree?: readonly (string | CopyToWorktree)[];
};
