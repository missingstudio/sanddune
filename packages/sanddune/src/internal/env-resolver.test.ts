import { describe, expect, test } from "bun:test";
import { resolveEnv } from "./env-resolver";

describe("resolveEnv", () => {
  test("includes regular keys from processEnv", () => {
    const env = resolveEnv({
      processEnv: {
        ANTHROPIC_API_KEY: "sk-test",
        SOMETHING_USEFUL: "42",
      },
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(env["SOMETHING_USEFUL"]).toBe("42");
  });

  test("filters host-only shell variables out of processEnv", () => {
    const env = resolveEnv({
      processEnv: {
        ANTHROPIC_API_KEY: "sk-test",
        HOME: "/Users/me",
        USER: "me",
        PATH: "/opt/homebrew/bin:/usr/bin",
        PWD: "/Users/me/proj",
        OLDPWD: "/Users/me",
        SHLVL: "2",
        TERM_PROGRAM: "iTerm.app",
        COLORTERM: "truecolor",
      },
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(env["HOME"]).toBeUndefined();
    expect(env["USER"]).toBeUndefined();
    expect(env["PATH"]).toBeUndefined();
    expect(env["PWD"]).toBeUndefined();
    expect(env["OLDPWD"]).toBeUndefined();
    expect(env["SHLVL"]).toBeUndefined();
    expect(env["TERM_PROGRAM"]).toBeUndefined();
    expect(env["COLORTERM"]).toBeUndefined();
  });

  test("agentEnv and sandboxEnv bypass the filter", () => {
    const env = resolveEnv({
      processEnv: {},
      agentEnv: { HOME: "/explicit/home" },
      sandboxEnv: { PATH: "/explicit/path" },
    });
    expect(env["HOME"]).toBe("/explicit/home");
    expect(env["PATH"]).toBe("/explicit/path");
  });

  test("agentEnv and sandboxEnv override values from processEnv", () => {
    const env = resolveEnv({
      processEnv: { ANTHROPIC_API_KEY: "process" },
      agentEnv: { ANTHROPIC_API_KEY: "agent" },
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("agent");
  });

  test("rejects overlapping keys between agent and sandbox env", () => {
    expect(() =>
      resolveEnv({
        processEnv: {},
        agentEnv: { SHARED: "agent" },
        sandboxEnv: { SHARED: "sandbox" },
      }),
    ).toThrow(/SHARED/);
  });

  test("ignores undefined values from processEnv", () => {
    const env = resolveEnv({
      processEnv: { DEFINED: "yes", UNDEFINED: undefined },
    });
    expect(env["DEFINED"]).toBe("yes");
    expect(env["UNDEFINED"]).toBeUndefined();
  });
});
