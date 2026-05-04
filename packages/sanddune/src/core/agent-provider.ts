import type { IterationUsage } from "./run";

export type AgentStreamEvent =
  | {
      readonly type: "text";
      readonly content: string;
      readonly iteration: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "toolCall";
      readonly name: string;
      readonly input: unknown;
      readonly iteration: number;
      readonly timestamp: number;
    };

export interface AgentBuildCommandInput {
  readonly prompt: string;
  readonly iteration: number;
  readonly resumeSessionId?: string;
}

export interface AgentInteractiveCommandInput {
  readonly prompt?: string;
  /** When true, the provider skips its permission prompts. Cleared for
   *  no-sandbox so the agent's prompts stay active. */
  readonly skipPermissions: boolean;
}

/** Sandbox paths may begin with `~` (evaluated by the sandbox shell);
 *  rewriteCwd operates line-by-line over the JSONL. */
export interface AgentSessionCapture {
  parseSessionId(line: string): string | undefined;
  hostSessionPath(hostCwd: string, sessionId: string): string;
  sandboxSessionPath(sandboxCwd: string, sessionId: string): string;
  rewriteCwd(jsonl: string, fromCwd: string, toCwd: string): string;
  /** Convention: read the last assistant message — its usage is cumulative
   *  for the iteration. */
  parseUsage?(jsonl: string): IterationUsage | undefined;
}

export interface AgentProvider {
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly sessionCapture?: AgentSessionCapture;
  buildCommand(input: AgentBuildCommandInput): string;
  parseLine(line: string, iteration: number): readonly AgentStreamEvent[];
  /** Omit when the agent has no TUI; interactive() then rejects at runtime. */
  buildInteractiveCommand?(input: AgentInteractiveCommandInput): string;
}
