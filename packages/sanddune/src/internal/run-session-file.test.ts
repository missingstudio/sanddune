import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentStreamEvent } from "../core";
import { openFileRunSession } from "./run-session-file";

function textEvent(content: string, iteration = 1): AgentStreamEvent {
  return { type: "text", content, iteration, timestamp: Date.now() };
}

describe("openFileRunSession", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sanddune-rsf-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the run log under .sanddune/logs by default", async () => {
    const session = await openFileRunSession({ cwd: dir });
    await session.endOk();

    expect(session.logFilePath).toMatch(/\.sanddune\/logs\/.+\.jsonl$/);
    const content = await readFile(session.logFilePath!, "utf8");
    expect(content).toContain(`"type":"run-start"`);
    expect(content).toContain(`"type":"run-end"`);
    expect(content).toContain(`"status":"ok"`);
  });

  test("default filename includes branch and name when supplied", async () => {
    const session = await openFileRunSession({
      cwd: dir,
      branch: "agent/feat",
      name: "issue 42",
    });
    await session.endOk();

    // Branch's `/` and name's space both sanitize to `-`. Run-id suffix still
    // present so parallel `sandbox.run({ branch, name })` calls never collide.
    expect(session.logFilePath).toMatch(
      /\.sanddune\/logs\/agent-feat-issue-42-.+\.jsonl$/,
    );
  });

  test("default filename uses just branch when name omitted", async () => {
    const session = await openFileRunSession({
      cwd: dir,
      branch: "main",
    });
    await session.endOk();

    expect(session.logFilePath).toMatch(/\.sanddune\/logs\/main-.+\.jsonl$/);
  });

  test("custom path is used verbatim and parent dirs are created", async () => {
    const customPath = join(dir, "nested", "logs", "my-run.jsonl");
    const session = await openFileRunSession({ cwd: dir, path: customPath });
    await session.endOk();

    expect(session.logFilePath).toBe(customPath);
    const content = await readFile(customPath, "utf8");
    expect(content).toContain(`"type":"run-start"`);
  });

  test("onAgentStreamEvent receives every recorded event with iteration + timestamp", async () => {
    const received: AgentStreamEvent[] = [];
    const session = await openFileRunSession({
      cwd: dir,
      onAgentStreamEvent: (event) => {
        received.push(event);
      },
    });

    const t = textEvent("hi", 1);
    const tool: AgentStreamEvent = {
      type: "toolCall",
      name: "Read",
      input: { path: "/x" },
      iteration: 2,
      timestamp: 999,
    };
    session.recordAgentEvent(t);
    session.recordAgentEvent(tool);

    await session.endOk();
    expect(received).toEqual([t, tool]);
  });

  test("onAgentStreamEvent errors are swallowed — run still reaches endOk", async () => {
    const session = await openFileRunSession({
      cwd: dir,
      onAgentStreamEvent: () => {
        throw new Error("forwarder broken");
      },
    });

    // recordAgentEvent must not propagate the throw; the run must still
    // close cleanly so a buggy callback can't kill the run.
    expect(() => session.recordAgentEvent(textEvent("hi"))).not.toThrow();
    await session.endOk();
    const content = await readFile(session.logFilePath!, "utf8");
    expect(content).toContain(`"status":"ok"`);
  });

  test("name prefix appears in the tail-f hint", async () => {
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof originalWrite }).write = ((
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof originalWrite;
    try {
      const session = await openFileRunSession({ cwd: dir, name: "issue-42" });
      await session.endOk();
    } finally {
      (process.stdout as unknown as { write: typeof originalWrite }).write =
        originalWrite;
    }
    const out = captured.join("");
    expect(out).toContain("[issue-42] sanddune: streaming run log to");
    expect(out).toContain("[issue-42]   tail -f ");
  });

  test("endOk is idempotent — calling twice does not double-write", async () => {
    const session = await openFileRunSession({ cwd: dir });
    await session.endOk();
    await session.endOk();
    const content = await readFile(session.logFilePath!, "utf8");
    const endRecords = content
      .split("\n")
      .filter((l) => l.includes(`"type":"run-end"`));
    expect(endRecords).toHaveLength(1);
  });
});
