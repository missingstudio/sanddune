import type { AgentStreamEvent } from "./agent-provider";

export type LoggingOption =
  | {
    readonly type: "file";
    readonly path?: string;
    readonly onAgentStreamEvent?: (event: AgentStreamEvent) => void;
  }
  | { readonly type: "stdout" };
