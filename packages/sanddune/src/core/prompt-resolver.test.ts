import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolvePrompt } from "./prompt-resolver";

describe("resolvePrompt", () => {
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

  test("inline path returns the string verbatim", async () => {
    const result = await resolvePrompt({ prompt: "do the thing {{NOT_A_KEY}}" });
    expect(result).toEqual({
      kind: "inline",
      text: "do the thing {{NOT_A_KEY}}",
    });
  });

  test("template path returns file contents and the promptArgs map untouched", async () => {
    const file = join(tmp, "prompt.md");
    await writeFile(file, "Work on {{ISSUE}}\n");

    const result = await resolvePrompt({
      promptFile: file,
      promptArgs: { ISSUE: "42" },
    });

    expect(result).toEqual({
      kind: "template",
      text: "Work on {{ISSUE}}\n",
      promptArgs: { ISSUE: "42" },
      absolutePath: file,
    });
  });

  test("template path defaults promptArgs to an empty object when omitted", async () => {
    const file = join(tmp, "prompt.md");
    await writeFile(file, "no placeholders here\n");

    const result = await resolvePrompt({ promptFile: file });

    expect(result.kind).toBe("template");
    if (result.kind === "template") {
      expect(result.promptArgs).toEqual({});
    }
  });

  test("rejects when both prompt and promptFile are passed", async () => {
    await expect(
      resolvePrompt({
        prompt: "x",
        promptFile: "y.md",
      } as { prompt: string; promptFile: string }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("rejects when neither prompt nor promptFile is passed", async () => {
    await expect(resolvePrompt({})).rejects.toThrow(/prompt is required/);
  });

  test("rejects promptArgs combined with an inline prompt", async () => {
    await expect(
      resolvePrompt({
        prompt: "x",
        promptArgs: { K: "v" },
      } as { prompt: string; promptArgs: { K: string } }),
    ).rejects.toThrow(/promptArgs.*inline/);
  });

  test("missing promptFile throws an error naming the resolved absolute path", async () => {
    const missing = join(tmp, "nope.md");
    await expect(resolvePrompt({ promptFile: missing })).rejects.toThrow(
      missing,
    );
  });

  test("relative promptFile resolves against process.cwd(), not the caller's other notion of cwd", async () => {
    const callerDir = await mkdtemp(join(tmpdir(), "sanddune-prompt-cwd-"));
    const otherDir = await mkdtemp(join(tmpdir(), "sanddune-prompt-other-"));
    try {
      await writeFile(join(callerDir, "prompt.md"), "from caller cwd\n");
      await writeFile(join(otherDir, "prompt.md"), "from other dir\n");

      process.chdir(callerDir);
      // macOS reports the realpath of /var/folders/... as /private/var/folders/...
      // so derive the expected path from process.cwd() after chdir.
      const canonicalCallerDir = process.cwd();

      const result = await resolvePrompt({ promptFile: "prompt.md" });

      expect(result.kind).toBe("template");
      if (result.kind === "template") {
        expect(result.text).toBe("from caller cwd\n");
        expect(result.absolutePath).toBe(
          resolvePath(canonicalCallerDir, "prompt.md"),
        );
      }
    } finally {
      await rm(callerDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  test("absolute promptFile is used as-is", async () => {
    const file = join(tmp, "abs.md");
    await writeFile(file, "absolute\n");

    const result = await resolvePrompt({ promptFile: file });

    expect(result.kind).toBe("template");
    if (result.kind === "template") {
      expect(result.absolutePath).toBe(file);
      expect(result.text).toBe("absolute\n");
    }
  });
});
