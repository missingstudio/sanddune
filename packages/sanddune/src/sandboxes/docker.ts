import { resolve } from "node:path";
import type {
  BindMountCreateOptions,
  BindMountSandboxHandle,
  BindMountSandboxProvider,
  ExecOptions,
  ExecResult,
} from "../core";
import {
  defaultImageName,
  resolveParentGitMount,
  type BindMount,
} from "../internal/bind-mount-provisioning";
import { spawnHost } from "../internal/host-process";

export interface DockerOptions {
  readonly image?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const SANDBOX_WORKTREE = "/workspace";

export function docker(options?: DockerOptions): BindMountSandboxProvider {
  return {
    kind: "bind-mount",
    name: "docker",
    env: options?.env,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const hostWorktreePath = resolve(createOptions.worktreePath);
      const image =
        options?.image ?? defaultImageName(createOptions.hostRepoPath);

      await ensureImageExists(image);

      const extraGitMount = await resolveParentGitMount(hostWorktreePath);

      const containerId = await dockerRun({
        image,
        hostWorktreePath,
        extraMounts: extraGitMount ? [extraGitMount] : [],
        env: createOptions.env,
      });

      return {
        worktreePath: SANDBOX_WORKTREE,
        exec: (command, execOptions) =>
          dockerExec(containerId, command, execOptions),
        close: async () => {
          await dockerRm(containerId);
        },
      };
    },
  };
}

async function ensureImageExists(image: string): Promise<void> {
  const result = await spawnHost("docker", ["image", "inspect", image]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Docker image "${image}" not found. Build it with \`sanddune docker build-image\` (or pass an existing image via docker({ image: "..." })).`,
    );
  }
}

async function dockerRun(params: {
  image: string;
  hostWorktreePath: string;
  extraMounts: readonly BindMount[];
  env: Readonly<Record<string, string>>;
}): Promise<string> {
  const args = [
    "run",
    "-d",
    "--rm",
    "-v",
    `${params.hostWorktreePath}:${SANDBOX_WORKTREE}`,
    "-w",
    SANDBOX_WORKTREE,
  ];
  for (const mount of params.extraMounts) {
    args.push("-v", `${mount.hostPath}:${mount.sandboxPath}`);
  }
  for (const [key, value] of Object.entries(params.env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(params.image, "sleep", "infinity");

  const result = await spawnHost("docker", args);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker run failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function dockerExec(
  containerId: string,
  command: string,
  options?: ExecOptions,
): Promise<ExecResult> {
  const args = ["exec"];
  if (options?.cwd) {
    args.push("-w", options.cwd);
  }
  args.push(containerId, "sh", "-c", command);
  return spawnHost("docker", args, {
    onLine: options?.onLine,
    signal: options?.signal,
  });
}

async function dockerRm(containerId: string): Promise<void> {
  await spawnHost("docker", ["rm", "-f", containerId]);
}
