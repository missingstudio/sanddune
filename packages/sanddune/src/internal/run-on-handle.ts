import { Effect, Layer } from "effect";
import {
  AgentInvoker,
  type AgentProvider,
  type BindMountSandboxHandle,
  type PreparedPromptPipeline,
  type RunResult,
} from "../core";
import { makeProductionAgentInvoker } from "./agent-invoker-live";
import { gitHeadSha } from "./git";
import { runIterationLoop } from "./iteration-loop";
import { runEffect } from "./run-effect";
import type { RunSession } from "./run-session";
import { makeCaptureSessionFn } from "./session-capture";
import type { WorktreeStrategy } from "./worktree-strategy";

const DEFAULT_MAX_ITERATIONS = 1;
const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

export interface RunOnHandleInput {
  readonly handle: BindMountSandboxHandle;
  readonly strategy: WorktreeStrategy;
  readonly agent: AgentProvider;
  readonly hostRepoPath: string;
  readonly session: RunSession;
  readonly promptPipeline: PreparedPromptPipeline;
  readonly maxIterations?: number;
  readonly completionSignal?: string | readonly string[];
  readonly idleTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly resumeSessionId?: string;
  readonly agentInvokerLayer?: Layer.Layer<AgentInvoker, never, never>;
}

export async function runOnHandle(input: RunOnHandleInput): Promise<RunResult> {
  const { handle, strategy, agent, session, promptPipeline } = input;
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Commits past this SHA after the loop are the agent's contribution.
  const beforeSha = await gitHeadSha(strategy.worktreePath);

  const agentInvokerLayer =
    input.agentInvokerLayer ??
    Layer.succeed(
      AgentInvoker,
      makeProductionAgentInvoker({
        agentProvider: agent,
        handle,
      }),
    );

  const captureSession = makeCaptureSessionFn({
    handle,
    agent,
    hostCwd: input.hostRepoPath,
  });

  const loopResult = await runEffect(
    runIterationLoop({
      getPromptForIteration: () =>
        promptPipeline.getPromptForIteration((cmd) => handle.exec(cmd)),
      logger: session.logger,
      cwd: strategy.worktreePath,
      beforeSha,
      maxIterations,
      completionSignals: normalizeCompletionSignals(input.completionSignal),
      idleTimeoutSeconds:
        input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
      ...(input.signal !== undefined && { signal: input.signal }),
      ...(input.resumeSessionId !== undefined && {
        resumeSessionId: input.resumeSessionId,
      }),
      ...(captureSession !== undefined && { captureSession }),
      onEvent: session.recordAgentEvent,
    }).pipe(Effect.provide(agentInvokerLayer)),
  );

  return {
    branch: strategy.resultBranch,
    iterations: loopResult.iterations,
    commits: loopResult.commits,
    stdout: loopResult.stdout,
    ...(session.logFilePath !== undefined && {
      logFilePath: session.logFilePath,
    }),
    ...(loopResult.completionSignal !== undefined && {
      completionSignal: loopResult.completionSignal,
    }),
  };
}

function normalizeCompletionSignals(
  raw: string | readonly string[] | undefined,
): readonly string[] {
  if (raw === undefined) return [DEFAULT_COMPLETION_SIGNAL];
  if (typeof raw === "string") return [raw];
  return raw;
}
