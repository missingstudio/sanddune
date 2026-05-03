import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CopyToWorktreeTimeoutError } from "../core";
import { runCopyToWorktree } from "./copy-to-worktree";

let cwd: string;
let worktree: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "sanddune-copy-cwd-"));
  worktree = await mkdtemp(join(tmpdir(), "sanddune-copy-wt-"));
});

afterEach(async () => {
  await Bun.$`rm -rf ${cwd} ${worktree}`.quiet();
});

describe("runCopyToWorktree", () => {
  test("undefined items is a no-op", async () => {
    await runCopyToWorktree({
      items: undefined,
      cwd,
      worktreePath: worktree,
      branchStrategy: { type: "merge-to-head" },
      timeoutMs: undefined,
      signal: undefined,
    });
  });

  test("empty items is a no-op", async () => {
    await runCopyToWorktree({
      items: [],
      cwd,
      worktreePath: worktree,
      branchStrategy: { type: "merge-to-head" },
      timeoutMs: undefined,
      signal: undefined,
    });
  });

  test("relative paths resolve against cwd, not process.cwd()", async () => {
    await writeFile(join(cwd, ".env.example"), "FOO=bar\n");
    await runCopyToWorktree({
      items: [".env.example"],
      cwd,
      worktreePath: worktree,
      branchStrategy: { type: "merge-to-head" },
      timeoutMs: undefined,
      signal: undefined,
    });
    const copied = await readFile(join(worktree, ".env.example"), "utf8");
    expect(copied).toBe("FOO=bar\n");
  });

  test("absolute paths are used as-is", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "sanddune-copy-other-"));
    await writeFile(join(elsewhere, "extra.txt"), "hi\n");
    await runCopyToWorktree({
      items: [join(elsewhere, "extra.txt")],
      cwd,
      worktreePath: worktree,
      branchStrategy: { type: "branch", branch: "feat/x" },
      timeoutMs: undefined,
      signal: undefined,
    });
    const copied = await readFile(join(worktree, "extra.txt"), "utf8");
    expect(copied).toBe("hi\n");
    await Bun.$`rm -rf ${elsewhere}`.quiet();
  });

  test("copies directories recursively", async () => {
    await mkdir(join(cwd, "fixtures", "nested"), { recursive: true });
    await writeFile(join(cwd, "fixtures", "a.txt"), "a\n");
    await writeFile(join(cwd, "fixtures", "nested", "b.txt"), "b\n");
    await runCopyToWorktree({
      items: ["fixtures"],
      cwd,
      worktreePath: worktree,
      branchStrategy: { type: "merge-to-head" },
      timeoutMs: undefined,
      signal: undefined,
    });
    expect(await readFile(join(worktree, "fixtures", "a.txt"), "utf8")).toBe(
      "a\n",
    );
    expect(
      await readFile(join(worktree, "fixtures", "nested", "b.txt"), "utf8"),
    ).toBe("b\n");
  });

  test("copies multiple items in declared order", async () => {
    await writeFile(join(cwd, "one.txt"), "1\n");
    await writeFile(join(cwd, "two.txt"), "2\n");
    await runCopyToWorktree({
      items: ["one.txt", "two.txt"],
      cwd,
      worktreePath: worktree,
      branchStrategy: { type: "merge-to-head" },
      timeoutMs: undefined,
      signal: undefined,
    });
    expect(await readFile(join(worktree, "one.txt"), "utf8")).toBe("1\n");
    expect(await readFile(join(worktree, "two.txt"), "utf8")).toBe("2\n");
  });

  test("rejected with branchStrategy 'head'", async () => {
    await writeFile(join(cwd, "x.txt"), "x\n");
    await expect(
      runCopyToWorktree({
        items: ["x.txt"],
        cwd,
        worktreePath: worktree,
        branchStrategy: { type: "head" },
        timeoutMs: undefined,
        signal: undefined,
      }),
    ).rejects.toThrow(/copyToWorktree.*head/);
  });

  test("missing source surfaces cp error with non-zero exit", async () => {
    await expect(
      runCopyToWorktree({
        items: ["does-not-exist.txt"],
        cwd,
        worktreePath: worktree,
        branchStrategy: { type: "merge-to-head" },
        timeoutMs: undefined,
        signal: undefined,
      }),
    ).rejects.toThrow(/copyToWorktree failed/);
  });

  test("timeoutMs fires CopyToWorktreeTimeoutError when cp exceeds budget", async () => {
    // Generate a fixture cp can't churn through in ms: many small files
    // beats trying to make cp block on FIFOs (macOS cp -R copies the FIFO
    // node without reading it).
    const fixture = join(cwd, "many");
    await mkdir(fixture);
    await Promise.all(
      Array.from({ length: 4000 }, (_, i) =>
        writeFile(join(fixture, `f${i}.txt`), "x".repeat(64)),
      ),
    );
    const start = Date.now();
    await expect(
      runCopyToWorktree({
        items: ["many"],
        cwd,
        worktreePath: worktree,
        branchStrategy: { type: "merge-to-head" },
        timeoutMs: 5,
        signal: undefined,
      }),
    ).rejects.toBeInstanceOf(CopyToWorktreeTimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);
  });

  test("composes caller signal — pre-aborted signal rejects without spawning", async () => {
    await writeFile(join(cwd, "a.txt"), "a\n");
    const reason = new Error("cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      runCopyToWorktree({
        items: ["a.txt"],
        cwd,
        worktreePath: worktree,
        branchStrategy: { type: "merge-to-head" },
        timeoutMs: undefined,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  test("CopyToWorktreeTimeoutError is the typed error class", async () => {
    // Sanity-check the class shape so the wiring is at least exercised.
    const err = new CopyToWorktreeTimeoutError({ timeoutMs: 60_000 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CopyToWorktreeTimeoutError");
    expect(err.timeoutMs).toBe(60_000);
  });
});
