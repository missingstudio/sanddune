import { join, resolve as resolvePath } from "node:path";
import {
  type CreateSandboxOptions,
  type CreateSandboxProvider,
  type Sandbox,
} from "../core";
import {
  createSandboxFromWorktree,
  type CreateSandboxSeams,
} from "./create-sandbox";
import { resolveEnv } from "./env-resolver";
import { gitCurrentBranch } from "./git";
import { createWorktreeStrategy } from "./worktree-strategy";

export async function createSandboxProgram(
  options: CreateSandboxOptions<CreateSandboxProvider>,
  seams: CreateSandboxSeams = {},
): Promise<Sandbox> {
  if (options.sandbox.kind !== "bind-mount") {
    throw new Error(
      `createSandbox() supports only bind-mount sandbox providers in this release; got ${options.sandbox.kind}.`,
    );
  }

  const provider = options.sandbox;
  const cwd = resolvePath(options.cwd ?? process.cwd());

  const env = await resolveEnv({
    processEnv: process.env,
    sandduneEnvPath: join(cwd, ".sanddune", ".env"),
    agentEnv: options.agent.env,
    sandboxEnv: provider.env,
    runOptionsEnv: options.env,
  });

  const targetBranch = await gitCurrentBranch(cwd);

  const strategy = await createWorktreeStrategy({
    strategy: { type: "branch", branch: options.branch },
    providerKind: provider.kind,
    cwd,
    hostBranch: targetBranch,
  });

  const sandbox = await createSandboxFromWorktree({
    agent: options.agent,
    provider,
    hostRepoPath: cwd,
    strategy,
    env,
    hooks: options.hooks,
    copyToWorktree: options.copyToWorktree,
    timeouts: options.timeouts,
    logging: options.logging,
    ownsWorktree: true,
    seams,
  });

  return installSignalPreservation(sandbox, strategy.worktreePath);
}

function installSignalPreservation(
  sandbox: Sandbox,
  worktreePath: string,
): Sandbox {
  const onSignal = () => {
    process.stderr.write(
      `\nsanddune: worktree preserved at ${worktreePath}\n` +
        `  To review:    cd ${worktreePath}\n` +
        `  To clean up:  git worktree remove --force ${worktreePath}\n`,
    );
    process.exit(1);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let removed = false;
  const removeHandlers = () => {
    if (removed) return;
    removed = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };

  return {
    branch: sandbox.branch,
    worktreePath: sandbox.worktreePath,
    run: (opts) => sandbox.run(opts),
    interactive: (opts) => sandbox.interactive(opts),
    close: async () => {
      removeHandlers();
      return sandbox.close();
    },
    [Symbol.asyncDispose]: async () => {
      removeHandlers();
      await sandbox.close();
    },
  };
}
