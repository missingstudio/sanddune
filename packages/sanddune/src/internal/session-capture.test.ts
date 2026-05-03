import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentProvider,
  AgentSessionCapture,
  BindMountSandboxHandle,
  ExecOptions,
  ExecResult,
} from "../core";
import {
  makeCaptureSessionFn,
  transferSessionToSandbox,
  validateResumeSession,
} from "./session-capture";

/** A capture impl with no real Claude Code coupling — paths root at the
 *  caller-provided base dirs so tests can point them at tmpdirs. */
function makeFakeCapture(opts: {
  hostBase: string;
  sandboxBase: string;
}): AgentSessionCapture {
  return {
    parseSessionId: () => undefined,
    hostSessionPath: (_hostCwd, sessionId) =>
      `${opts.hostBase}/sessions/${sessionId}.jsonl`,
    sandboxSessionPath: (_sandboxCwd, sessionId) =>
      `${opts.sandboxBase}/${sessionId}.jsonl`,
    rewriteCwd: (jsonl, fromCwd, toCwd) =>
      jsonl.replaceAll(`"cwd":"${fromCwd}"`, `"cwd":"${toCwd}"`),
  };
}

function fakeAgent(capture?: AgentSessionCapture): AgentProvider {
  return {
    name: "fake",
    buildCommand: () => "x",
    parseLine: () => [],
    ...(capture !== undefined && { sessionCapture: capture }),
  };
}

interface ExecCall {
  readonly command: string;
  readonly options?: ExecOptions;
}
interface FakeHandleOptions {
  readonly worktreePath?: string;
  readonly onExec: (
    command: string,
    options?: ExecOptions,
  ) => Promise<ExecResult>;
}
function makeFakeHandle(
  opts: FakeHandleOptions,
): { readonly handle: BindMountSandboxHandle; readonly calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    handle: {
      worktreePath: opts.worktreePath ?? "/workspace",
      exec: async (command, options) => {
        calls.push({ command, ...(options !== undefined && { options }) });
        return opts.onExec(command, options);
      },
      close: async () => {},
    },
    calls,
  };
}

describe("validateResumeSession", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sanddune-session-validate-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("agent without sessionCapture → silently no-op (non-Claude providers ignore resume)", async () => {
    await expect(
      validateResumeSession({
        resumeSession: "abc",
        agent: fakeAgent(),
        hostCwd: "/anywhere",
        maxIterations: 1,
      }),
    ).resolves.toBeUndefined();
  });

  test("maxIterations > 1 → throws even before the file is checked", async () => {
    const capture = makeFakeCapture({ hostBase: dir, sandboxBase: "/sb" });
    await expect(
      validateResumeSession({
        resumeSession: "abc",
        agent: fakeAgent(capture),
        hostCwd: "/host",
        maxIterations: 2,
      }),
    ).rejects.toThrow(/incompatible with maxIterations > 1.*got 2/);
  });

  test("missing host file → throws with the path", async () => {
    const capture = makeFakeCapture({ hostBase: dir, sandboxBase: "/sb" });
    const expectedPath = `${dir}/sessions/missing-id.jsonl`;
    await expect(
      validateResumeSession({
        resumeSession: "missing-id",
        agent: fakeAgent(capture),
        hostCwd: "/host",
        maxIterations: 1,
      }),
    ).rejects.toThrow(
      new RegExp(`resumeSession "missing-id" not found at ${expectedPath}`),
    );
  });

  test("happy path: file exists and maxIterations=1 → resolves", async () => {
    const capture = makeFakeCapture({ hostBase: dir, sandboxBase: "/sb" });
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", "abc.jsonl"), "{}\n");
    await expect(
      validateResumeSession({
        resumeSession: "abc",
        agent: fakeAgent(capture),
        hostCwd: "/host",
        maxIterations: 1,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("transferSessionToSandbox", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sanddune-session-transfer-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads host file, rewrites cwd host→sandbox, writes via mkdir+base64 to sandbox path", async () => {
    const capture = makeFakeCapture({ hostBase: dir, sandboxBase: "/sb" });
    await mkdir(join(dir, "sessions"), { recursive: true });
    const hostJsonl =
      `{"type":"user","cwd":"/host"}\n` + `{"type":"assistant","cwd":"/host"}\n`;
    await writeFile(join(dir, "sessions", "abc.jsonl"), hostJsonl);

    const { handle, calls } = makeFakeHandle({
      onExec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });

    await transferSessionToSandbox({
      handle,
      capture,
      hostCwd: "/host",
      sessionId: "abc",
    });

    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.command;
    // mkdir uses the dirname of the sandbox path
    expect(cmd.startsWith("mkdir -p /sb ")).toBe(true);
    // base64 decode redirects into the sandbox path
    expect(cmd.endsWith("> /sb/abc.jsonl")).toBe(true);
    // The base64 payload decodes to the rewritten JSONL
    const m = cmd.match(/printf '%s' '([^']+)' \| base64 -d/);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, "base64").toString("utf8");
    expect(decoded).toContain(`"cwd":"/workspace"`);
    expect(decoded).not.toContain(`"cwd":"/host"`);
  });

  test("non-zero exec exit propagates as an error (resume failure is not best-effort)", async () => {
    const capture = makeFakeCapture({ hostBase: dir, sandboxBase: "/sb" });
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", "abc.jsonl"), "{}\n");

    const { handle } = makeFakeHandle({
      onExec: async () => ({ stdout: "", stderr: "boom", exitCode: 5 }),
    });

    await expect(
      transferSessionToSandbox({
        handle,
        capture,
        hostCwd: "/host",
        sessionId: "abc",
      }),
    ).rejects.toThrow(/exited 5.*boom/);
  });
});

describe("makeCaptureSessionFn", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sanddune-session-capture-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns undefined when the agent has no sessionCapture", () => {
    const { handle } = makeFakeHandle({
      onExec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    expect(
      makeCaptureSessionFn({ handle, agent: fakeAgent(), hostCwd: "/host" }),
    ).toBeUndefined();
  });

  test("happy path: cats sandbox file, rewrites sandbox→host, writes to host path, returns host path", async () => {
    const capture = makeFakeCapture({ hostBase: dir, sandboxBase: "/sb" });
    const sandboxJsonl =
      `{"type":"user","cwd":"/workspace"}\n` +
      `{"type":"assistant","cwd":"/workspace"}\n`;
    const { handle, calls } = makeFakeHandle({
      onExec: async (command) => {
        if (command.startsWith("cat ")) {
          return { stdout: sandboxJsonl, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const fn = makeCaptureSessionFn({
      handle,
      agent: fakeAgent(capture),
      hostCwd: "/host",
    });
    expect(fn).toBeDefined();

    const hostPath = await fn!({ iteration: 1, sessionId: "abc" });

    const expectedPath = `${dir}/sessions/abc.jsonl`;
    expect(hostPath).toBe(expectedPath);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("cat /sb/abc.jsonl");

    const written = await readFile(expectedPath, "utf8");
    // cwd rewritten sandbox → host
    expect(written).toContain(`"cwd":"/host"`);
    expect(written).not.toContain(`"cwd":"/workspace"`);
  });

  test("read failure → returns undefined, run still proceeds (best-effort capture)", async () => {
    const capture = makeFakeCapture({ hostBase: dir, sandboxBase: "/sb" });
    const { handle } = makeFakeHandle({
      onExec: async () => ({ stdout: "", stderr: "no such file", exitCode: 1 }),
    });

    const fn = makeCaptureSessionFn({
      handle,
      agent: fakeAgent(capture),
      hostCwd: "/host",
    });
    const result = await fn!({ iteration: 2, sessionId: "abc" });
    expect(result).toBeUndefined();
  });
});
