import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
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

export function docker(options?: DockerOptions): BindMountSandboxProvider {
  return createBindMountSandboxProvider({
    name: "docker",
    env: options?.env,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const hostWorktreePath = resolve(createOptions.worktreePath);
      const image = options?.image ?? `sanddune:${basename(hostWorktreePath)}`;

      await ensureImageExists(image);

      const containerId = await dockerRun({
        image,
        hostWorktreePath,
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

async function dockerRun(params: {
  image: string;
  hostWorktreePath: string;
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
