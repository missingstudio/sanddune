import { dirname } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type {
  AgentProvider,
  AgentSessionCapture,
  BindMountSandboxHandle,
  IterationUsage,
} from "../core";

/** Validates `RunOptions.resumeSession` BEFORE the sandbox is created. The
 *  early-throw contract matters because sandbox creation is expensive and
 *  side-effectful (a stray container/worktree is harder to clean up than a
 *  rejected `run()`).
 *
 *  Two failure modes — both throw a plain `Error`:
 *  - `maxIterations > 1`: long-lived iteration loops can't chain Claude
 *    session state through `--resume`, so the combination is rejected
 *    rather than silently ignoring one of the options.
 *  - host session file missing: `claude --resume` would fail later with a
 *    less-actionable error; we surface it up front.
 *
 *  Non-Claude **agent providers** (no `sessionCapture` capability) opt out
 *  entirely — `resumeSession` is silently dropped per the brief. */
export async function validateResumeSession(input: {
  readonly resumeSession: string;
  readonly agent: AgentProvider;
  readonly hostCwd: string;
  readonly maxIterations: number;
}): Promise<void> {
  const capture = input.agent.sessionCapture;
  if (capture === undefined) return;
  if (input.maxIterations > 1) {
    throw new Error(
      `resumeSession is incompatible with maxIterations > 1 (got ${input.maxIterations}). ` +
        `Resuming a Claude agent session is a fresh-sandbox concern; only iteration 1 receives --resume.`,
    );
  }
  const hostPath = capture.hostSessionPath(input.hostCwd, input.resumeSession);
  try {
    const s = await stat(hostPath);
    if (!s.isFile()) {
      throw new Error(`not a file: ${hostPath}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `resumeSession "${input.resumeSession}" not found at ${hostPath}: ${msg}`,
    );
  }
}

/** Transfers a host session JSONL into a live **sandbox** at the path the
 *  **agent** expects, with `cwd` fields rewritten from the **host** repo
 *  root to the sandbox-side worktree path. Called once after sandbox
 *  creation, before iteration 1.
 *
 *  Failure here is fatal — unlike capture, resume is something the user
 *  explicitly requested and a partial transfer would silently start a
 *  fresh session. We let the error propagate and `run()`'s teardown
 *  cleans up. */
export async function transferSessionToSandbox(input: {
  readonly handle: BindMountSandboxHandle;
  readonly capture: AgentSessionCapture;
  readonly hostCwd: string;
  readonly sessionId: string;
}): Promise<void> {
  const { handle, capture, hostCwd, sessionId } = input;
  const hostPath = capture.hostSessionPath(hostCwd, sessionId);
  const sandboxPath = capture.sandboxSessionPath(handle.worktreePath, sessionId);
  const original = await readFile(hostPath, "utf8");
  const rewritten = capture.rewriteCwd(original, hostCwd, handle.worktreePath);
  await writeFileInSandbox(handle, sandboxPath, rewritten);
}

export interface CaptureSessionResult {
  readonly hostPath: string;
  /** Raw token counts for the iteration, when the agent provider's
   *  `sessionCapture.parseUsage` is implemented and the captured JSONL has
   *  usage data. `undefined` when the capability is absent or the file
   *  contains no usable assistant message — capture is best-effort. */
  readonly usage?: IterationUsage;
}

/** Builds the best-effort capture closure handed to the **iteration loop**.
 *  Returns `undefined` when the agent has no `sessionCapture` capability —
 *  the loop then never asks. The closure resolves to a
 *  `CaptureSessionResult` on success (carrying the host path + optional
 *  usage), or `undefined` if capture failed (handled internally with a
 *  stderr warning — the run still proceeds). */
export function makeCaptureSessionFn(input: {
  readonly handle: BindMountSandboxHandle;
  readonly agent: AgentProvider;
  readonly hostCwd: string;
}):
  | ((args: {
      readonly iteration: number;
      readonly sessionId: string;
    }) => Promise<CaptureSessionResult | undefined>)
  | undefined {
  const capture = input.agent.sessionCapture;
  if (capture === undefined) return undefined;
  return async ({ iteration, sessionId }) => {
    try {
      const sandboxPath = capture.sandboxSessionPath(
        input.handle.worktreePath,
        sessionId,
      );
      const raw = await readFileFromSandbox(input.handle, sandboxPath);
      const rewritten = capture.rewriteCwd(
        raw,
        input.handle.worktreePath,
        input.hostCwd,
      );
      const hostPath = capture.hostSessionPath(input.hostCwd, sessionId);
      await mkdir(dirname(hostPath), { recursive: true });
      await writeFile(hostPath, rewritten);
      const usage = capture.parseUsage?.(rewritten);
      return usage !== undefined ? { hostPath, usage } : { hostPath };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `sanddune: agent session capture failed for iteration ${iteration} (session ${sessionId}): ${msg}\n`,
      );
      return undefined;
    }
  };
}

/** Reads a sandbox file by `cat`-ing it and capturing stdout. The path may
 *  begin with `~` (shell expands it inside the sandbox); leave unquoted. */
async function readFileFromSandbox(
  handle: BindMountSandboxHandle,
  sandboxPath: string,
): Promise<string> {
  const result = await handle.exec(`cat ${sandboxPath}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `cat ${sandboxPath} exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/** Writes content to a sandbox file via `printf '%s' '<b64>' | base64 -d`.
 *  Base64 sidesteps shell-quoting concerns for arbitrary JSONL bytes; the
 *  surrounding `mkdir -p` ensures the project dir exists. As with read,
 *  the sandbox path may begin with `~` and must stay unquoted. */
async function writeFileInSandbox(
  handle: BindMountSandboxHandle,
  sandboxPath: string,
  content: string,
): Promise<void> {
  const lastSlash = sandboxPath.lastIndexOf("/");
  if (lastSlash <= 0) {
    throw new Error(
      `sandbox session path must contain a directory component: ${sandboxPath}`,
    );
  }
  const sandboxDir = sandboxPath.slice(0, lastSlash);
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const command = `mkdir -p ${sandboxDir} && printf '%s' '${b64}' | base64 -d > ${sandboxPath}`;
  const result = await handle.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `writing ${sandboxPath} exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
}
