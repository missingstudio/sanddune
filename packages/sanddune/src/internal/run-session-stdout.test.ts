import { describe, expect, test } from "bun:test";
import type { AgentStreamEvent } from "../core";
import { openStdoutRunSession } from "./run-session-stdout";

/** Strips ANSI escape sequences so assertions can match against plain text
 *  without binding to the styling. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function makeWriter() {
  const chunks: string[] = [];
  return {
    write: (s: string) => chunks.push(s),
    output: () => chunks.join(""),
    plain: () => stripAnsi(chunks.join("")),
  };
}

describe("openStdoutRunSession (terminal mode)", () => {
  test("renders a header on construction", async () => {
    const w = makeWriter();
    await openStdoutRunSession({ writer: w.write, isTTY: false });
    expect(w.plain()).toContain("sanddune run starting");
  });

  test("iterationStarted / iterationEnded render a progress line + commit summary in non-TTY mode", async () => {
    const w = makeWriter();
    const session = await openStdoutRunSession({ writer: w.write, isTTY: false });

    await session.logger.iterationStarted(1);
    await session.logger.iterationEnded(1, "abcdef0123456789");
    await session.endOk();

    const out = w.plain();
    expect(out).toContain("iteration 1 starting");
    // Commit sha trimmed to a stable prefix in the rendered tail.
    expect(out).toContain("iteration 1 — committed abcdef012345");
    expect(out).toContain("run completed");
  });

  test("iterationEnded with no commit reports 'no commit'", async () => {
    const w = makeWriter();
    const session = await openStdoutRunSession({ writer: w.write, isTTY: false });

    await session.logger.iterationStarted(1);
    await session.logger.iterationEnded(1, null);
    await session.endOk();

    expect(w.plain()).toContain("iteration 1 — no commit");
  });

  test("endError renders a failure line carrying the message", async () => {
    const w = makeWriter();
    const session = await openStdoutRunSession({ writer: w.write, isTTY: false });
    await session.endError("agent exploded");
    expect(w.plain()).toContain("run failed: agent exploded");
  });

  test("endOk / endError are idempotent — second call is a no-op", async () => {
    const w = makeWriter();
    const session = await openStdoutRunSession({ writer: w.write, isTTY: false });
    await session.endOk();
    const before = w.plain();
    await session.endOk();
    await session.endError("ignored");
    expect(w.plain()).toBe(before);
  });

  test("name prefix is applied to every rendered line", async () => {
    const w = makeWriter();
    const session = await openStdoutRunSession({
      writer: w.write,
      isTTY: false,
      name: "issue-42",
    });
    await session.logger.iterationStarted(1);
    await session.logger.iterationEnded(1, null);
    await session.endOk();

    // Header, iteration-start, iteration-end, run-completed all carry the prefix.
    const lines = w.plain().split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line.startsWith("[issue-42] ")).toBe(true);
    }
  });

  test("toolCall agent events render a tool name; text events stay silent", async () => {
    const w = makeWriter();
    const session = await openStdoutRunSession({ writer: w.write, isTTY: false });
    const text: AgentStreamEvent = {
      type: "text",
      content: "thinking out loud",
      iteration: 1,
      timestamp: 0,
    };
    const tool: AgentStreamEvent = {
      type: "toolCall",
      name: "Read",
      input: { path: "/tmp/x" },
      iteration: 1,
      timestamp: 0,
    };

    session.recordAgentEvent(text);
    const afterText = w.plain();
    expect(afterText).not.toContain("thinking out loud");

    session.recordAgentEvent(tool);
    expect(w.plain()).toContain("→ tool: Read");
  });

  test("logFilePath is undefined in terminal mode", async () => {
    const w = makeWriter();
    const session = await openStdoutRunSession({ writer: w.write, isTTY: false });
    expect(session.logFilePath).toBeUndefined();
  });
});
