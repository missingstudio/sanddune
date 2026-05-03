import { homedir } from "node:os";
import { describe, expect, test } from "bun:test";
import { claudeCode } from "./claude-code";

describe("claudeCode buildCommand", () => {
  test("emits --dangerously-skip-permissions and the prompt; no --resume by default", () => {
    const provider = claudeCode("claude-opus-4-7");
    const cmd = provider.buildCommand({ prompt: "do the thing", iteration: 1 });
    expect(cmd).toContain("'do the thing'");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--resume");
  });

  test("appends --resume <id> when resumeSessionId is set", () => {
    const provider = claudeCode("claude-opus-4-7");
    const cmd = provider.buildCommand({
      prompt: "continue",
      iteration: 1,
      resumeSessionId: "abc-123",
    });
    expect(cmd).toContain("--resume 'abc-123'");
    // resume must come before the prompt arg, after the model + skip-perms,
    // so the trailing positional prompt remains the last token group.
    const resumeIdx = cmd.indexOf("--resume");
    const promptIdx = cmd.lastIndexOf("'continue'");
    expect(resumeIdx).toBeGreaterThan(0);
    expect(promptIdx).toBeGreaterThan(resumeIdx);
  });

  test("shell-quotes session id (defensive — Claude session ids are uuid-like)", () => {
    const provider = claudeCode("m");
    const cmd = provider.buildCommand({
      prompt: "p",
      iteration: 1,
      resumeSessionId: "weird'id",
    });
    expect(cmd).toContain(`--resume 'weird'\\''id'`);
  });
});

describe("claudeCode sessionCapture capability", () => {
  test("present by default", () => {
    expect(claudeCode("m").sessionCapture).toBeDefined();
  });

  test("absent when captureSessions: false (opt-out)", () => {
    expect(claudeCode("m", { captureSessions: false }).sessionCapture).toBeUndefined();
  });

  test("present when captureSessions: true (explicit)", () => {
    expect(claudeCode("m", { captureSessions: true }).sessionCapture).toBeDefined();
  });
});

describe("claudeCode sessionCapture.parseSessionId", () => {
  const capture = claudeCode("m").sessionCapture!;

  test("extracts session_id from a system/init line", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123-def",
      cwd: "/workspace",
    });
    expect(capture.parseSessionId(line)).toBe("abc-123-def");
  });

  test("returns undefined for non-init system lines", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "tool_result",
      session_id: "should-be-ignored",
    });
    expect(capture.parseSessionId(line)).toBeUndefined();
  });

  test("returns undefined for assistant lines (the streaming text)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(capture.parseSessionId(line)).toBeUndefined();
  });

  test("returns undefined for malformed JSON / blank lines", () => {
    expect(capture.parseSessionId("")).toBeUndefined();
    expect(capture.parseSessionId("not json")).toBeUndefined();
    expect(capture.parseSessionId("{")).toBeUndefined();
  });

  test("returns undefined when session_id is missing or empty", () => {
    expect(
      capture.parseSessionId(
        JSON.stringify({ type: "system", subtype: "init" }),
      ),
    ).toBeUndefined();
    expect(
      capture.parseSessionId(
        JSON.stringify({ type: "system", subtype: "init", session_id: "" }),
      ),
    ).toBeUndefined();
  });
});

describe("claudeCode sessionCapture path encoding", () => {
  const capture = claudeCode("m").sessionCapture!;

  test("hostSessionPath uses HOME, encoded cwd, and the sessions/ subdir", () => {
    const p = capture.hostSessionPath("/Users/me/repo", "abc-123");
    expect(p).toBe(
      `${homedir()}/.claude/projects/-Users-me-repo/sessions/abc-123.jsonl`,
    );
  });

  test("sandboxSessionPath uses ~ + encoded cwd, no sessions/ subdir", () => {
    const p = capture.sandboxSessionPath("/workspace", "abc-123");
    expect(p).toBe("~/.claude/projects/-workspace/abc-123.jsonl");
  });
});

describe("claudeCode sessionCapture.rewriteCwd", () => {
  const capture = claudeCode("m").sessionCapture!;

  test("rewrites cwd in every matching record (sandbox → host)", () => {
    const sandbox = "/workspace";
    const host = "/Users/me/repo";
    const jsonl =
      JSON.stringify({ type: "user", cwd: sandbox, message: "a" }) +
      "\n" +
      JSON.stringify({ type: "assistant", cwd: sandbox, message: "b" }) +
      "\n";
    const out = capture.rewriteCwd(jsonl, sandbox, host);
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line).cwd).toBe(host);
    }
  });

  test("rewrites in the reverse direction too (host → sandbox), used by resume transfer", () => {
    const sandbox = "/workspace";
    const host = "/Users/me/repo";
    const jsonl =
      JSON.stringify({ type: "user", cwd: host }) + "\n";
    const out = capture.rewriteCwd(jsonl, host, sandbox);
    const line = out.split("\n").find((l) => l.length > 0)!;
    expect(JSON.parse(line).cwd).toBe(sandbox);
  });

  test("leaves records with non-matching cwd untouched", () => {
    const jsonl =
      JSON.stringify({ type: "user", cwd: "/something/else" }) + "\n";
    const out = capture.rewriteCwd(jsonl, "/workspace", "/host");
    const line = out.split("\n").find((l) => l.length > 0)!;
    expect(JSON.parse(line).cwd).toBe("/something/else");
  });

  test("preserves trailing newline and skips malformed lines", () => {
    const sandbox = "/workspace";
    const host = "/host";
    const good = JSON.stringify({ type: "user", cwd: sandbox });
    const jsonl = `${good}\nnot json\n`;
    const out = capture.rewriteCwd(jsonl, sandbox, host);
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.split("\n");
    expect(JSON.parse(lines[0]!).cwd).toBe(host);
    expect(lines[1]).toBe("not json");
  });
});
