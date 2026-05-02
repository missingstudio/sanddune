import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  type ExecOptions,
  type ExecResult,
} from "@missingstudio/sanddune-core";

export interface DockerOptions {
  readonly image?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const SANDBOX_WORKTREE = "/workspace";

/** Default image tag derived from the host repo's directory name.
 *  Lowercased and sanitized so any repo dir produces a valid tag. */
export function defaultImageName(hostRepoPath: string): string {
  const dirName =
    hostRepoPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sanddune:${sanitized || "local"}`;
}

export function docker(options?: DockerOptions): BindMountSandboxProvider {
  return createBindMountSandboxProvider({
    name: "docker",
    env: options?.env,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const hostWorktreePath = resolve(createOptions.worktreePath);
      const image =
        options?.image ?? defaultImageName(createOptions.hostRepoPath);

      await ensureImageExists(image);

      // When the worktree is a git worktree (not a regular checkout),
      // `<worktree>/.git` is a pointer file at `gitdir: <host>/.git/worktrees/<id>`.
      // The container can't follow that pointer unless we also bind-mount the
      // parent .git dir at its host path. Per ADR-0006.
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
  });
}

async function ensureImageExists(image: string): Promise<void> {
  const result = await runHostProcess(
    "docker",
    ["image", "inspect", image],
    {},
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Docker image "${image}" not found. Build it with \`sanddune docker build-image\` (or pass an existing image via docker({ image: "..." })).`,
    );
  }
}

interface BindMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
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

  const result = await runHostProcess("docker", args, {});
  if (result.exitCode !== 0) {
    throw new Error(
      `docker run failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

/** When `<worktreePath>/.git` is a pointer file (worktree, not regular
 *  checkout), parse it to find the parent `.git` directory and return a
 *  bind-mount entry for it. Returns null when the worktree's `.git` is a
 *  directory (regular checkout) or when the pointer can't be parsed. */
export async function resolveParentGitMount(
  worktreePath: string,
): Promise<BindMount | null> {
  const gitPath = join(worktreePath, ".git");
  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return null;
  }
  if (!gitStat.isFile()) return null;

  let content: string;
  try {
    content = await readFile(gitPath, "utf8");
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;

  const gitdirPath = match[1];
  if (typeof gitdirPath !== "string") return null;

  // gitdirPath is e.g. /repo/.git/worktrees/<id>. Walk up until we hit the
  // segment named `.git` — that's the parent .git directory we need to mount.
  let dir = gitdirPath;
  while (basename(dir) !== ".git" && dir !== "/" && dir.length > 0) {
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  if (basename(dir) !== ".git") return null;

  return { hostPath: dir, sandboxPath: dir };
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
  return runHostProcess("docker", args, { onLine: options?.onLine });
}

async function dockerRm(containerId: string): Promise<void> {
  await runHostProcess("docker", ["rm", "-f", containerId], {});
}

function runHostProcess(
  cmd: string,
  args: readonly string[],
  options: { onLine?: (line: string) => void },
): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    if (options.onLine && proc.stdout) {
      const onLine = options.onLine;
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        stdoutChunks.push(line);
        onLine(line);
      });
    } else if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString());
      });
    }

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      const stdout = options.onLine
        ? stdoutChunks.join("\n")
        : stdoutChunks.join("");
      resolvePromise({
        stdout,
        stderr: stderrChunks.join(""),
        exitCode: code ?? 0,
      });
    });
  });
}
