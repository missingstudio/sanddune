import { describe, expect, test } from "bun:test";
import { substitutePromptArgs } from "./prompt-argument-substitution";

const BRANCHES = {
  sourceBranch: "agent/temp-abc",
  targetBranch: "main",
};

describe("substitutePromptArgs", () => {
  describe("substitution", () => {
    test.each([
      ["single placeholder", "Work on {{ISSUE}}", { ISSUE: "42" }, "Work on 42"],
      [
        "repeated placeholder is replaced everywhere",
        "{{X}} and {{X}} again",
        { X: "y" },
        "y and y again",
      ],
      ["numeric values are stringified", "issue {{N}}", { N: 7 }, "issue 7"],
      [
        "lowercase keys work",
        "branch {{my_branch}}",
        { my_branch: "feat/x" },
        "branch feat/x",
      ],
      [
        "unmatched braces are left alone",
        "this { is } not a placeholder",
        {},
        "this { is } not a placeholder",
      ],
      [
        "no placeholders is identity",
        "no replacements here",
        {},
        "no replacements here",
      ],
    ] as const)("%s", (_name, text, promptArgs, expected) => {
      const result = substitutePromptArgs({
        text,
        promptArgs,
        ...BRANCHES,
      });
      expect(result.text).toBe(expected);
      expect(result.unusedKeys).toEqual([]);
    });
  });

  describe("built-in arguments", () => {
    test("{{SOURCE_BRANCH}} and {{TARGET_BRANCH}} are injected automatically", () => {
      const result = substitutePromptArgs({
        text: "from {{SOURCE_BRANCH}} into {{TARGET_BRANCH}}",
        promptArgs: {},
        sourceBranch: "agent/x",
        targetBranch: "main",
      });
      expect(result.text).toBe("from agent/x into main");
    });

    test.each(["SOURCE_BRANCH", "TARGET_BRANCH"] as const)(
      "passing %s in promptArgs throws (built-ins cannot be overridden)",
      (key) => {
        expect(() =>
          substitutePromptArgs({
            text: "noop",
            promptArgs: { [key]: "something" },
            ...BRANCHES,
          }),
        ).toThrow(`Built-in prompt argument {{${key}}}`);
      },
    );
  });

  describe("missing keys", () => {
    test("a placeholder with no matching arg throws naming the key", () => {
      expect(() =>
        substitutePromptArgs({
          text: "Work on {{ISSUE}}",
          promptArgs: {},
          ...BRANCHES,
        }),
      ).toThrow(/\{\{ISSUE\}\}/);
    });

    test("multiple missing keys are all reported", () => {
      let caught: unknown;
      try {
        substitutePromptArgs({
          text: "{{A}} and {{B}}",
          promptArgs: {},
          ...BRANCHES,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      expect(msg).toContain("{{A}}");
      expect(msg).toContain("{{B}}");
      expect(msg).toMatch(/placeholders/);
    });
  });

  describe("unused keys", () => {
    test("returns unused keys without throwing", () => {
      const result = substitutePromptArgs({
        text: "Just {{USED}}",
        promptArgs: { USED: "ok", EXTRA: "ignored" },
        ...BRANCHES,
      });
      expect(result.text).toBe("Just ok");
      expect(result.unusedKeys).toEqual(["EXTRA"]);
    });

    test("empty promptArgs has no unused keys and no failure", () => {
      const result = substitutePromptArgs({
        text: "no placeholders",
        promptArgs: {},
        ...BRANCHES,
      });
      expect(result.text).toBe("no placeholders");
      expect(result.unusedKeys).toEqual([]);
    });
  });

  describe("shell expressions", () => {
    test("`!` markers in the template body pass through untouched after substitution", () => {
      const result = substitutePromptArgs({
        text: "run !`gh issue view {{ISSUE}}`",
        promptArgs: { ISSUE: "42" },
        ...BRANCHES,
      });
      expect(result.text).toBe("run !`gh issue view 42`");
    });

    test("`!` markers inside promptArgs values are inert text", () => {
      const result = substitutePromptArgs({
        text: "{{CMD}}",
        promptArgs: { CMD: "!`pwd`" },
        ...BRANCHES,
      });
      expect(result.text).toBe("!`pwd`");
    });

    test("{{KEY}} appearing inside an arg value is not re-scanned (single-pass)", () => {
      const result = substitutePromptArgs({
        text: "{{A}}",
        promptArgs: { A: "{{B}}", B: "leaked" },
        ...BRANCHES,
      });
      expect(result.text).toBe("{{B}}");
      expect(result.unusedKeys).toEqual(["B"]);
    });
  });
});
