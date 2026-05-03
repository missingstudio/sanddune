import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  preparePromptPipeline,
  type SandboxExec,
} from "./prompt-pipeline";
import type { ExecResult } from "./sandbox-provider";

const BRANCHES = {
  sourceBranch: "agent/temp-abc",
  targetBranch: "main",
};

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

const EXEC_NEVER: SandboxExec = () => {
  throw new Error("exec must not be called");
};

describe("preparePromptPipeline — option validation", () => {
  test("rejects when both prompt and promptFile are passed", async () => {
    await expect(
      preparePromptPipeline({
        prompt: "x",
        promptFile: "y.md",
        ...BRANCHES,
      } as never),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("rejects when neither prompt nor promptFile is passed", async () => {
    await expect(
      preparePromptPipeline({ ...BRANCHES }),
    ).rejects.toThrow(/prompt is required/);
  });

  test("rejects promptArgs combined with an inline prompt", async () => {
    await expect(
      preparePromptPipeline({
        prompt: "x",
        promptArgs: { K: "v" },
        ...BRANCHES,
      } as never),
    ).rejects.toThrow(/promptArgs.*inline/);
  });
});

describe("preparePromptPipeline — inline prompt (ADR-0008)", () => {
  test("returns the string verbatim each iteration; never invokes exec", async () => {
    const inlineWithBacktickSyntax =
      "do !`echo this should be left alone` and report {{NOT_A_KEY}}";
    const pipeline = await preparePromptPipeline({
      prompt: inlineWithBacktickSyntax,
      ...BRANCHES,
    });

    const a = await pipeline.getPromptForIteration(EXEC_NEVER);
    const b = await pipeline.getPromptForIteration(EXEC_NEVER);
    expect(a).toBe(inlineWithBacktickSyntax);
    expect(b).toBe(inlineWithBacktickSyntax);
    expect(pipeline.unusedPromptArgKeys).toEqual([]);
  });
});

describe("preparePromptPipeline — file resolution", () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sanddune-prompt-"));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  test("missing promptFile throws an error naming the resolved absolute path", async () => {
    const missing = join(tmp, "nope.md");
    await expect(
      preparePromptPipeline({ promptFile: missing, ...BRANCHES }),
    ).rejects.toThrow(missing);
  });

  test("relative promptFile resolves against process.cwd(), not anything else", async () => {
    const callerDir = await mkdtemp(join(tmpdir(), "sanddune-prompt-cwd-"));
    const otherDir = await mkdtemp(join(tmpdir(), "sanddune-prompt-other-"));
    try {
      await writeFile(join(callerDir, "prompt.md"), "from caller cwd\n");
      await writeFile(join(otherDir, "prompt.md"), "from other dir\n");

      process.chdir(callerDir);
      const canonicalCallerDir = process.cwd();

      const pipeline = await preparePromptPipeline({
        promptFile: "prompt.md",
        ...BRANCHES,
      });
      // Sanity that we got the caller-cwd file.
      const text = await pipeline.getPromptForIteration(EXEC_NEVER);
      expect(text).toBe("from caller cwd\n");
      // Path used is relative to canonicalCallerDir.
      expect(resolvePath(canonicalCallerDir, "prompt.md")).toMatch(/prompt\.md$/);
    } finally {
      await rm(callerDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  test("absolute promptFile is read as-is", async () => {
    const file = join(tmp, "abs.md");
    await writeFile(file, "absolute\n");
    const pipeline = await preparePromptPipeline({
      promptFile: file,
      ...BRANCHES,
    });
    expect(await pipeline.getPromptForIteration(EXEC_NEVER)).toBe("absolute\n");
  });
});

describe("preparePromptPipeline — argument substitution", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sanddune-prompt-sub-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function pipelineFor(
    body: string,
    promptArgs: Record<string, string | number> = {},
  ) {
    const file = join(tmp, "p.md");
    await writeFile(file, body);
    return preparePromptPipeline({
      promptFile: file,
      promptArgs,
      ...BRANCHES,
    });
  }

  test("single placeholder is replaced", async () => {
    const p = await pipelineFor("Work on {{ISSUE}}", { ISSUE: "42" });
    expect(await p.getPromptForIteration(EXEC_NEVER)).toBe("Work on 42");
  });

  test("repeated placeholder is replaced everywhere; unused keys are surfaced", async () => {
    const p = await pipelineFor("{{X}} and {{X}}", { X: "y", EXTRA: "ignored" });
    expect(await p.getPromptForIteration(EXEC_NEVER)).toBe("y and y");
    expect(p.unusedPromptArgKeys).toEqual(["EXTRA"]);
  });

  test("numeric values are stringified", async () => {
    const p = await pipelineFor("issue {{N}}", { N: 7 });
    expect(await p.getPromptForIteration(EXEC_NEVER)).toBe("issue 7");
  });

  test("built-in {{SOURCE_BRANCH}} and {{TARGET_BRANCH}} are injected", async () => {
    const p = await pipelineFor("from {{SOURCE_BRANCH}} into {{TARGET_BRANCH}}");
    expect(await p.getPromptForIteration(EXEC_NEVER)).toBe(
      `from ${BRANCHES.sourceBranch} into ${BRANCHES.targetBranch}`,
    );
  });

  test("passing SOURCE_BRANCH or TARGET_BRANCH in promptArgs throws", async () => {
    await expect(
      pipelineFor("noop", { SOURCE_BRANCH: "x" }),
    ).rejects.toThrow(/Built-in prompt argument \{\{SOURCE_BRANCH\}\}/);
    await expect(
      pipelineFor("noop", { TARGET_BRANCH: "x" }),
    ).rejects.toThrow(/Built-in prompt argument \{\{TARGET_BRANCH\}\}/);
  });

  test.each(["issue-num", "1ISSUE", "with space", "key.with.dots", ""] as const)(
    "rejects invalid promptArgs key %p",
    async (key) => {
      await expect(pipelineFor("noop", { [key]: "v" })).rejects.toThrow(
        /Invalid promptArgs key/,
      );
    },
  );

  test("missing placeholder throws naming the key(s)", async () => {
    await expect(pipelineFor("Work on {{ISSUE}}")).rejects.toThrow(
      /\{\{ISSUE\}\}/,
    );
    await expect(pipelineFor("{{A}} and {{B}}")).rejects.toThrow(
      /\{\{A\}\}.*\{\{B\}\}|\{\{B\}\}.*\{\{A\}\}/,
    );
  });

  test("a placeholder value containing {{KEY}} is not re-scanned (single-pass)", async () => {
    const p = await pipelineFor("{{A}}", { A: "{{B}}", B: "leaked" });
    expect(await p.getPromptForIteration(EXEC_NEVER)).toBe("{{B}}");
    expect(p.unusedPromptArgKeys).toEqual(["B"]);
  });

  test("template with no shell expressions never invokes exec across iterations", async () => {
    const p = await pipelineFor("Work on {{ISSUE}}", { ISSUE: "42" });
    expect(await p.getPromptForIteration(EXEC_NEVER)).toBe("Work on 42");
    expect(await p.getPromptForIteration(EXEC_NEVER)).toBe("Work on 42");
  });
});

describe("preparePromptPipeline — shell expansion", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sanddune-prompt-exp-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function pipelineFor(
    body: string,
    promptArgs: Record<string, string | number> = {},
  ) {
    const file = join(tmp, "p.md");
    await writeFile(file, body);
    return preparePromptPipeline({
      promptFile: file,
      promptArgs,
      ...BRANCHES,
    });
  }

  test("single marker replaced with stdout (trailing newline stripped); exec runs each iteration", async () => {
    const p = await pipelineFor("branch: !`git rev-parse --abbrev-ref HEAD`");
    const calls: string[] = [];
    let i = 0;
    const exec: SandboxExec = async (cmd) => {
      calls.push(cmd);
      i += 1;
      return ok(`iter-${i}\n`);
    };
    expect(await p.getPromptForIteration(exec)).toBe("branch: iter-1");
    expect(await p.getPromptForIteration(exec)).toBe("branch: iter-2");
    expect(calls).toEqual([
      "git rev-parse --abbrev-ref HEAD",
      "git rev-parse --abbrev-ref HEAD",
    ]);
  });

  test("multiple markers run in parallel — peak inflight == count", async () => {
    const p = await pipelineFor("!`a` !`b` !`c`");
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const allDispatched = new Promise<void>((res) => {
      release = res;
    });

    const exec: SandboxExec = async (cmd) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (inFlight === 3) release();
      await allDispatched;
      inFlight--;
      return ok(`${cmd}\n`);
    };
    expect(await p.getPromptForIteration(exec)).toBe("a b c");
    expect(peak).toBe(3);
  });

  test("non-zero exit rejects with the offending command and exit code", async () => {
    const p = await pipelineFor("result: !`failing-cmd --flag`");
    let caught: unknown;
    try {
      await p.getPromptForIteration(async () => ({
        stdout: "",
        stderr: "boom",
        exitCode: 2,
      }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("!`failing-cmd --flag`");
    expect(msg).toContain("exit 2");
    expect(msg).toContain("boom");
  });

  test("first non-zero exit wins; siblings do not poison the rejection", async () => {
    const p = await pipelineFor("!`fail` and !`slow`");
    const exec: SandboxExec = async (cmd) => {
      if (cmd === "fail") return { stdout: "", stderr: "", exitCode: 3 };
      await new Promise((r) => setTimeout(r, 5));
      return ok("late\n");
    };
    await expect(p.getPromptForIteration(exec)).rejects.toThrow(
      /exit 3.*!`fail`/s,
    );
  });

  test("empty stdout produces empty replacement", async () => {
    const p = await pipelineFor("x:!`empty`y");
    expect(await p.getPromptForIteration(async () => ok(""))).toBe("x:y");
  });

  test("trailing newlines stripped; interior newlines preserved", async () => {
    const p1 = await pipelineFor("log: !`git log`");
    expect(
      await p1.getPromptForIteration(async () => ok("line1\nline2\nline3\n")),
    ).toBe("log: line1\nline2\nline3");

    const p2 = await pipelineFor("x: !`cmd`");
    expect(await p2.getPromptForIteration(async () => ok("foo\n\n\n"))).toBe(
      "x: foo",
    );
  });

  test("two adjacent markers with no separator both expand", async () => {
    const p = await pipelineFor("!`a`!`b`");
    expect(
      await p.getPromptForIteration(async (cmd) => ok(`${cmd}\n`)),
    ).toBe("ab");
  });

  test("empty shell expression !`` is rejected before any exec dispatches", async () => {
    const p = await pipelineFor("before !`` after");
    await expect(p.getPromptForIteration(EXEC_NEVER)).rejects.toThrow(
      /empty shell expression/i,
    );
  });

  test("exec rejection is wrapped with the offending command and preserves cause", async () => {
    const p = await pipelineFor("result: !`gh issue view 42`");
    const sandboxDied = new Error("sandbox connection closed");
    let caught: unknown;
    try {
      await p.getPromptForIteration(async () => {
        throw sandboxDied;
      });
    } catch (e) {
      caught = e;
    }
    const err = caught as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("!`gh issue view 42`");
    expect(err.message).toContain("sandbox connection closed");
    expect(err.cause).toBe(sandboxDied);
  });

  test("argument substitution happens before expansion — {{KEY}} can land inside !`...`", async () => {
    const p = await pipelineFor("run !`gh issue view {{ISSUE}}`", {
      ISSUE: "42",
    });
    let captured = "";
    await p.getPromptForIteration(async (cmd) => {
      captured = cmd;
      return ok("ok\n");
    });
    expect(captured).toBe("gh issue view 42");
  });
});
