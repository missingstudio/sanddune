import { Effect } from "effect";
import { resolve as resolvePath } from "node:path";
import type {
  AgentInvokerService,
  AgentProvider,
  AgentStreamEvent,
  BindMountSandboxHandle,
  IterationResult,
  RunOptions,
  RunResult,
  RunSandboxProvider,
} from "@missingstudio/sanddune-core";
import { resolveEnv } from "./env-resolver";
import {
  gitCurrentBranch,
  gitHeadSha,
  gitNewCommits,
} from "./git";
import { openRunLog } from "./run-log";
import { newRunId } from "./run-id";
import { makeProductionAgentInvoker } from "./agent-invoker-live";

export interface BuildInvokerDeps {
  readonly agentProvider: AgentProvider;
  readonly handle: BindMountSandboxHandle;
  readonly env: Readonly<Record<string, string>>;
  readonly onEvent: (event: AgentStreamEvent) => void;
}

export type BuildInvoker = (deps: BuildInvokerDeps) => AgentInvokerService;

export const productionBuildInvoker: BuildInvoker = (deps) =>
  makeProductionAgentInvoker({
    agentProvider: deps.agentProvider,
    handle: deps.handle,
    onEvent: deps.onEvent,
  });

export async function runProgram(
  options: RunOptions<RunSandboxProvider>,
  buildInvoker: BuildInvoker = productionBuildInvoker,
): Promise<RunResult> {
  if (typeof options.prompt !== "string") {
    throw new Error(
      "run() requires an inline `prompt` string in this release. `promptFile` is not yet supported.",
    );
  }
  if (options.sandbox.kind !== "bind-mount") {
    throw new Error(
      `run() supports only bind-mount sandbox providers in this release; got ${options.sandbox.kind}.`,
    );
  }
  const branchStrategy = options.branchStrategy ?? { type: "head" };
  if (branchStrategy.type !== "head") {
    throw new Error(
      `run() supports only the "head" branch strategy in this release; got "${branchStrategy.type}".`,
    );
  }

  const provider = options.sandbox;
  const cwd = resolvePath(options.cwd ?? process.cwd());
  const env = resolveEnv({
    processEnv: process.env,
    agentEnv: options.agent.env,
    sandboxEnv: provider.env,
  });
  const targetBranch = await gitCurrentBranch(cwd);
  const sourceBranch = targetBranch;

  const runId = newRunId();
  const log = await openRunLog(cwd, runId);
  process.stdout.write(
    `sanddune: streaming run log to ${log.path}\n  tail -f ${log.path}\n`,
  );

  await log.write({ type: "run-start", timestamp: Date.now() });

  const beforeSha = await gitHeadSha(cwd);

  let handle: BindMountSandboxHandle | undefined;
  try {
    handle = await provider.create({ worktreePath: cwd, env });

    await log.write({
      type: "iteration-start",
      iteration: 1,
      timestamp: Date.now(),
    });

    const invoker = buildInvoker({
      agentProvider: options.agent,
      handle,
      env,
      onEvent: (event) => {
        void log.write({ type: "agent-event", event });
      },
    });

    await Effect.runPromise(
      invoker.invoke({ prompt: options.prompt, iteration: 1 }),
    );

    const commits = await gitNewCommits(cwd, beforeSha);
    const lastCommit = commits.at(-1);

    await log.write({
      type: "iteration-end",
      iteration: 1,
      timestamp: Date.now(),
      ...(lastCommit !== undefined ? { commitSha: lastCommit } : {}),
    });

    const iterations: IterationResult[] = [
      lastCommit !== undefined
        ? { iteration: 1, commitSha: lastCommit }
        : { iteration: 1 },
    ];

    await log.write({
      type: "run-end",
      timestamp: Date.now(),
      status: "ok",
    });

    return {
      sourceBranch,
      targetBranch,
      iterations,
      commits,
    };
  } catch (error) {
    await log.write({
      type: "run-end",
      timestamp: Date.now(),
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        process.stderr.write(
          `sanddune: sandbox teardown failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
        );
      }
    }
    await log.close();
  }
}
