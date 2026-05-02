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
}

export interface AgentProvider {
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
  buildCommand(input: AgentBuildCommandInput): string;
  parseLine(line: string, iteration: number): readonly AgentStreamEvent[];
}

export function createAgentProvider(config: {
  readonly name: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly buildCommand: (input: AgentBuildCommandInput) => string;
  readonly parseLine: (
    line: string,
    iteration: number,
  ) => readonly AgentStreamEvent[];
}): AgentProvider {
  return {
    name: config.name,
    env: config.env,
    buildCommand: config.buildCommand,
    parseLine: config.parseLine,
  };
}
