import { describe, expect, test } from "bun:test";
import { expandPrompt, type SandboxExec } from "./prompt-expansion";
import type { ExecResult } from "./sandbox-provider";

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

const failingExec: SandboxExec = () => {
  throw new Error("exec should not have been called");
};

describe("expandPrompt", () => {
  test("text with no markers passes through unchanged and skips exec", async () => {
    const result = await expandPrompt({
      text: "no shell expressions here",
      exec: failingExec,
    });
    expect(result.text).toBe("no shell expressions here");
  });

  test("single marker is replaced with stdout (trailing newline trimmed)", async () => {
    const calls: string[] = [];
    const result = await expandPrompt({
      text: "branch: !`git rev-parse --abbrev-ref HEAD`",
      exec: async (cmd) => {
        calls.push(cmd);
        return ok("main\n");
      },
    });
    expect(result.text).toBe("branch: main");
    expect(calls).toEqual(["git rev-parse --abbrev-ref HEAD"]);
  });

  test("multiple markers across lines are all replaced in place", async () => {
    const result = await expandPrompt({
      text: "first: !`echo a`\nsecond: !`echo b`\nthird: !`echo c`",
      exec: async (cmd) => ok(`${cmd.replace("echo ", "")}\n`),
    });
    expect(result.text).toBe("first: a\nsecond: b\nthird: c");
  });

  test("markers evaluate in parallel — all exec calls dispatch before any resolves", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    let release!: () => void;
    const allDispatched = new Promise<void>((res) => {
      release = res;
    });

    const exec: SandboxExec = async (cmd) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (inFlight === 3) release();
      await allDispatched;
      inFlight--;
      return ok(`${cmd}\n`);
    };

    const result = await expandPrompt({
      text: "!`a` !`b` !`c`",
      exec,
    });

    expect(result.text).toBe("a b c");
    expect(peakInFlight).toBe(3);
  });

  test("non-zero exit rejects with the offending command and exit code", async () => {
    let caught: unknown;
    try {
      await expandPrompt({
        text: "result: !`failing-cmd --flag`",
        exec: async () => ({ stdout: "", stderr: "boom", exitCode: 2 }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("!`failing-cmd --flag`");
    expect(msg).toContain("exit 2");
    expect(msg).toContain("boom");
  });

  test("first non-zero exit wins; the still-running siblings do not poison the rejection", async () => {
    const exec: SandboxExec = async (cmd) => {
      if (cmd === "fail") {
        return { stdout: "", stderr: "", exitCode: 3 };
      }
      // Slow success — should still settle on the sandbox but its result is
      // discarded once the failing sibling rejects the Promise.all.
      await new Promise((r) => setTimeout(r, 5));
      return ok("late\n");
    };

    await expect(
      expandPrompt({ text: "!`fail` and !`slow`", exec }),
    ).rejects.toThrow(/exit 3.*!`fail`/s);
  });

  test("empty stdout produces empty replacement (marker disappears)", async () => {
    const result = await expandPrompt({
      text: "x:!`empty`y",
      exec: async () => ok(""),
    });
    expect(result.text).toBe("x:y");
  });

  test("trailing newlines are trimmed; interior newlines are preserved", async () => {
    const single = await expandPrompt({
      text: "log: !`git log`",
      exec: async () => ok("line1\nline2\nline3\n"),
    });
    expect(single.text).toBe("log: line1\nline2\nline3");

    const multi = await expandPrompt({
      text: "x: !`cmd`",
      exec: async () => ok("foo\n\n\n"),
    });
    expect(multi.text).toBe("x: foo");
  });

  test("two adjacent markers with no separator both expand", async () => {
    const result = await expandPrompt({
      text: "!`a`!`b`",
      exec: async (cmd) => ok(`${cmd}\n`),
    });
    expect(result.text).toBe("ab");
  });

  test("empty shell expression !`` is rejected before any exec dispatches", async () => {
    await expect(
      expandPrompt({
        text: "before !`` after",
        exec: failingExec,
      }),
    ).rejects.toThrow(/empty shell expression/i);
  });

  test("exec rejection is wrapped with the offending command", async () => {
    let caught: unknown;
    const sandboxDied = new Error("sandbox connection closed");
    try {
      await expandPrompt({
        text: "result: !`gh issue view 42`",
        exec: async () => {
          throw sandboxDied;
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain("!`gh issue view 42`");
    expect(err.message).toContain("sandbox connection closed");
    expect(err.cause).toBe(sandboxDied);
  });
});
