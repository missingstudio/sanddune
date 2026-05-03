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

  // `branch: string` is the only knob — long-lived sandboxes are
  // single-branch by construction, so there is no `branchStrategy`
  // surface here (CONTEXT.md "createSandbox opts out of the branch
  // strategy abstraction").
  const strategy = await createWorktreeStrategy({
    strategy: { type: "branch", branch: options.branch },
    providerKind: provider.kind,
    cwd,
    hostBranch: targetBranch,
  });

  // On lifecycle failure, the helper closes any partial container and (because
  // `ownsWorktree` is true here) unwinds the worktree before rethrowing.
  return await createSandboxFromWorktree({
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
}
