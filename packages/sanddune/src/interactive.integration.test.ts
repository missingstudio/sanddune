import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentProvider,
  type BindMountSandboxProvider,
} from "./core";
import { createWorktree, interactive } from "./index";
import { noSandbox } from "./sandboxes/no-sandbox";

describe("interactive (integration)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sanddune-int-it-"));
    runSync("git", ["init", "--initial-branch=main"], repo);
    runSync("git", ["config", "user.email", "test@example.com"], repo);
    runSync("git", ["config", "user.name", "test"], repo);
    runSync("git", ["config", "commit.gpgsign", "false"], repo);
    await writeFile(join(repo, "README.md"), "seed\n");
    runSync("git", ["add", "."], repo);
    runSync("git", ["commit", "-m", "seed"], repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("noSandbox: agent runs on host with skipPermissions=false (no --dangerously-skip-permissions)", async () => {
    const agent = makeMarkerAgent();
    await interactive({
      agent,
      sandbox: noSandbox(),
      prompt: "hello",
      cwd: repo,
    });
    expect(readFileSync(join(repo, "skip.txt"), "utf8")).toBe("false\n");
    expect(readFileSync(join(repo, "prompt.txt"), "utf8")).toBe("hello\n");
  });

  test("noSandbox: TUI launches without a prompt when none supplied", async () => {
    const agent = makeMarkerAgent();
    await interactive({
      agent,
      sandbox: noSandbox(),
      cwd: repo,
    });
    expect(readFileSync(join(repo, "prompt.txt"), "utf8")).toBe("<no-prompt>\n");
    expect(readFileSync(join(repo, "skip.txt"), "utf8")).toBe("false\n");
  });

  test("bind-mount: agent receives skipPermissions=true (the --dangerously-skip-permissions flag)", async () => {
    const interactiveCalls: { command: string; cwd: string | undefined }[] =
      [];
    const closeCalls: number[] = [];
    const provider = makeFakeBindMountProvider({
      closeCalls,
      interactiveCalls,
    });
    const agent: AgentProvider = {
      name: "fake",
      buildCommand: () => "true",
      parseLine: () => [],
      buildInteractiveCommand: ({ skipPermissions }) =>
        `echo skip=${skipPermissions}`,
    };
    await interactive({
      agent,
      sandbox: provider,
      prompt: "hi",
      cwd: repo,
    });
    expect(interactiveCalls).toHaveLength(1);
    expect(interactiveCalls[0]!.command).toBe("echo skip=true");
    // Container is closed even on the happy path.
    expect(closeCalls).toEqual([1]);
  });

  test("rejects when the agent provider lacks buildInteractiveCommand", async () => {
    const agent: AgentProvider = {
      name: "afk-only",
      buildCommand: () => "true",
      parseLine: () => [],
    };
    await expect(
      interactive({
        agent,
        sandbox: noSandbox(),
        prompt: "x",
        cwd: repo,
      }),
    ).rejects.toThrow(/does not support interactive/);
  });

  test("rejects when the bind-mount handle lacks execInteractive", async () => {
    const provider: BindMountSandboxProvider = {
      kind: "bind-mount",
      name: "no-interactive-handle",
      create: async ({ worktreePath }) => ({
        worktreePath,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        close: async () => {},
      }),
    };
    const agent: AgentProvider = {
      name: "fake",
      buildCommand: () => "true",
      parseLine: () => [],
      buildInteractiveCommand: () => "true",
    };
    await expect(
      interactive({
        agent,
        sandbox: provider,
        prompt: "x",
        cwd: repo,
      }),
    ).rejects.toThrow(/does not support interactive sessions/);
  });

  test("cwd override: agent runs in the supplied cwd, not process.cwd()", async () => {
    const other = await mkdtemp(join(tmpdir(), "sanddune-int-other-"));
    runSync("git", ["init", "--initial-branch=main"], other);
    runSync("git", ["config", "user.email", "t@e.com"], other);
    runSync("git", ["config", "user.name", "t"], other);
    runSync("git", ["config", "commit.gpgsign", "false"], other);
    await writeFile(join(other, "README.md"), "other\n");
    runSync("git", ["add", "."], other);
    runSync("git", ["commit", "-m", "x"], other);

    try {
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: () => `printf 'here\\n' > marker.txt`,
      };
      await interactive({
        agent,
        sandbox: noSandbox(),
        prompt: "x",
        cwd: other,
      });
      expect(existsSync(join(other, "marker.txt"))).toBe(true);
      expect(existsSync(join(repo, "marker.txt"))).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("signal: pre-aborted signal rejects with the caller's reason", async () => {
    const agent: AgentProvider = {
      name: "fake",
      buildCommand: () => "true",
      parseLine: () => [],
      buildInteractiveCommand: () => `printf 'should-not-run\\n' > marker.txt`,
    };

    const controller = new AbortController();
    controller.abort(new Error("user cancel"));

    await expect(
      interactive({
        agent,
        sandbox: noSandbox(),
        prompt: "x",
        cwd: repo,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/user cancel/);

    // The agent never spawned, so no marker was written.
    expect(existsSync(join(repo, "marker.txt"))).toBe(false);
  });

  test("env: declared sanddune env reaches the host-spawned agent (noSandbox)", async () => {
    const agent: AgentProvider = {
      name: "fake",
      env: { FAKE_TOKEN: "from-agent" },
      buildCommand: () => "true",
      parseLine: () => [],
      buildInteractiveCommand: () =>
        `printf '%s\\n' "$FAKE_TOKEN" > token.txt`,
    };
    await interactive({
      agent,
      sandbox: noSandbox(),
      prompt: "x",
      cwd: repo,
    });
    expect(readFileSync(join(repo, "token.txt"), "utf8")).toBe("from-agent\n");
  });
});

describe("wt.interactive (integration)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "sanddune-wti-it-"));
    runSync("git", ["init", "--initial-branch=main"], repo);
    runSync("git", ["config", "user.email", "test@example.com"], repo);
    runSync("git", ["config", "user.name", "test"], repo);
    runSync("git", ["config", "commit.gpgsign", "false"], repo);
    await writeFile(join(repo, "README.md"), "seed\n");
    runSync("git", ["add", "."], repo);
    runSync("git", ["commit", "-m", "seed"], repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("defaults to noSandbox when no sandbox is supplied", async () => {
    const wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "agent/tui" },
      cwd: repo,
    });
    try {
      const agent = makeMarkerAgent();
      await wt.interactive({ agent, prompt: "hi" });
      // skipPermissions=false confirms the default provider was noSandbox().
      expect(readFileSync(join(wt.worktreePath, "skip.txt"), "utf8")).toBe(
        "false\n",
      );
      expect(readFileSync(join(wt.worktreePath, "prompt.txt"), "utf8")).toBe(
        "hi\n",
      );
    } finally {
      await wt.close();
    }
  });

  test("worktree survives the interactive session (ownership-follows-creation)", async () => {
    const wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "agent/persist" },
      cwd: repo,
    });
    const path = wt.worktreePath;
    try {
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: () => "true",
      };
      await wt.interactive({ agent });
      // The parent Worktree owns the dir; interactive() must not tear it down.
      expect(existsSync(path)).toBe(true);
    } finally {
      await wt.close();
    }
  });

  test("explicit bind-mount sandbox: launched inside the worktree, with skipPermissions=true", async () => {
    const wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "agent/bm-tui" },
      cwd: repo,
    });
    try {
      const interactiveCalls: { command: string; cwd: string | undefined }[] =
        [];
      const closeCalls: number[] = [];
      const provider = makeFakeBindMountProvider({
        closeCalls,
        interactiveCalls,
      });
      const agent: AgentProvider = {
        name: "fake",
        buildCommand: () => "true",
        parseLine: () => [],
        buildInteractiveCommand: ({ skipPermissions }) =>
          `echo skip=${skipPermissions}`,
      };
      await wt.interactive({ agent, sandbox: provider });
      expect(interactiveCalls).toHaveLength(1);
      expect(interactiveCalls[0]!.command).toBe("echo skip=true");
      expect(closeCalls).toEqual([1]);
    } finally {
      await wt.close();
    }
  });

  test("rejects after the parent worktree is closed", async () => {
    const wt = await createWorktree({
      branchStrategy: { type: "branch", branch: "agent/closed" },
      cwd: repo,
    });
    await wt.close();
    const agent: AgentProvider = {
      name: "fake",
      buildCommand: () => "true",
      parseLine: () => [],
      buildInteractiveCommand: () => "true",
    };
    await expect(wt.interactive({ agent })).rejects.toThrow(
      /worktree is closed/,
    );
  });
});

/** A fake **agent provider** whose `buildInteractiveCommand` writes its
 *  inputs (skipPermissions, prompt) to marker files in the worktree so the
 *  test can verify them after the TUI "exits". */
function makeMarkerAgent(): AgentProvider {
  return {
    name: "fake-marker",
    buildCommand: () => "true",
    parseLine: () => [],
    buildInteractiveCommand: ({ prompt, skipPermissions }) =>
      [
        `printf '${skipPermissions ? "true" : "false"}\\n' > skip.txt`,
        `printf '%s\\n' '${(prompt ?? "<no-prompt>").replace(/'/g, `'\\''`)}' > prompt.txt`,
      ].join(" && "),
  };
}

/** A bind-mount provider that records every `execInteractive` call and
 *  runs the command synchronously via `spawnSync` so tests can assert
 *  filesystem side effects without TTY allocation. */
function makeFakeBindMountProvider(input: {
  closeCalls: number[];
  interactiveCalls: { command: string; cwd: string | undefined }[];
}): BindMountSandboxProvider {
  return {
    kind: "bind-mount",
    name: "fake-interactive",
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (command, opts) => {
        const r = spawnSync("sh", ["-c", command], {
          cwd: opts?.cwd ?? worktreePath,
          encoding: "utf8",
        });
        return {
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.status ?? 0,
        };
      },
      execInteractive: async (command, opts) => {
        opts?.signal?.throwIfAborted?.();
        input.interactiveCalls.push({ command, cwd: opts?.cwd });
        const r = spawnSync("sh", ["-c", command], {
          cwd: opts?.cwd ?? worktreePath,
          encoding: "utf8",
        });
        return { exitCode: r.status ?? 0 };
      },
      close: async () => {
        input.closeCalls.push(1);
      },
    }),
  };
}

function runSync(
  cmd: string,
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${r.stderr ?? ""}${r.stdout ?? ""}`,
    );
  }
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
