import {
  preparePromptPipeline,
  type AgentProvider,
  type ExecResult,
  type PromptArgs,
} from "../core";

export interface InteractivePromptInput {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly promptArgs?: PromptArgs;
}

export interface ResolveInteractivePromptInput {
  readonly promptInput: InteractivePromptInput;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly execAdapter: (command: string) => Promise<ExecResult>;
}

/** Returns undefined when the caller passed neither prompt nor promptFile. */
export async function resolveInteractivePrompt(
  input: ResolveInteractivePromptInput,
): Promise<string | undefined> {
  if (
    input.promptInput.prompt === undefined &&
    input.promptInput.promptFile === undefined
  ) {
    return undefined;
  }
  const pipeline = await preparePromptPipeline({
    ...(input.promptInput.prompt !== undefined && {
      prompt: input.promptInput.prompt,
    }),
    ...(input.promptInput.promptFile !== undefined && {
      promptFile: input.promptInput.promptFile,
    }),
    ...(input.promptInput.promptArgs !== undefined && {
      promptArgs: input.promptInput.promptArgs,
    }),
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
  });
  for (const key of pipeline.unusedPromptArgKeys) {
    process.stderr.write(
      `sanddune: warning — promptArgs.${key} was not used by the template\n`,
    );
  }
  return pipeline.getPromptForIteration(input.execAdapter);
}

export function buildAgentInteractiveCommand(input: {
  readonly agent: AgentProvider;
  readonly prompt: string | undefined;
  readonly skipPermissions: boolean;
}): string {
  if (input.agent.buildInteractiveCommand === undefined) {
    throw new Error(
      `Agent provider "${input.agent.name}" does not support interactive() (no buildInteractiveCommand).`,
    );
  }
  return input.agent.buildInteractiveCommand({
    ...(input.prompt !== undefined && { prompt: input.prompt }),
    skipPermissions: input.skipPermissions,
  });
}
