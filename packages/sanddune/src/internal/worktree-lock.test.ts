import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireWorktreeLock } from "./worktree-lock";

describe("acquireWorktreeLock", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sanddune-lock-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("creates a lock file with the current pid and branch", async () => {
    const lock = await acquireWorktreeLock({
      cwd,
      id: "abc",
      branch: "feat/x",
    });

    const content = await readFile(lock.path, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.branch).toBe("feat/x");
    expect(typeof parsed.acquiredAt).toBe("string");

    await lock.release();
  });

  test("release() removes the lock file and is idempotent", async () => {
    const lock = await acquireWorktreeLock({
      cwd,
      id: "abc",
      branch: "feat/x",
    });

    await lock.release();
    await expect(readFile(lock.path, "utf8")).rejects.toThrow();

    // Idempotent — second release does not throw.
    await lock.release();
  });

  test("fails fast when the lock is held by a live process", async () => {
    const first = await acquireWorktreeLock({
      cwd,
      id: "abc",
      branch: "feat/x",
    });

    await expect(
      acquireWorktreeLock({ cwd, id: "abc", branch: "feat/y" }),
    ).rejects.toThrow(
      new RegExp(
        `Worktree lock is held by process ${process.pid}.*"feat/x"`,
      ),
    );

    await first.release();
  });

  test("reacquires after a stale lock (dead pid)", async () => {
    const lockPath = join(cwd, ".sanddune", "locks", "abc.lock");
    await mkdir(join(cwd, ".sanddune", "locks"), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 99999999, // very unlikely to be alive
        branch: "feat/zombie",
        acquiredAt: new Date().toISOString(),
      }),
    );

    const lock = await acquireWorktreeLock({
      cwd,
      id: "abc",
      branch: "feat/x",
    });

    const content = JSON.parse(await readFile(lock.path, "utf8"));
    expect(content.pid).toBe(process.pid);
    expect(content.branch).toBe("feat/x");

    await lock.release();
  });

  test("reacquires when the existing lock file is malformed", async () => {
    const lockPath = join(cwd, ".sanddune", "locks", "abc.lock");
    await mkdir(join(cwd, ".sanddune", "locks"), { recursive: true });
    await writeFile(lockPath, "this is not json");

    // Malformed → readLockOwner returns null → treated as stale.
    const lock = await acquireWorktreeLock({
      cwd,
      id: "abc",
      branch: "feat/x",
    });

    const content = JSON.parse(await readFile(lock.path, "utf8"));
    expect(content.pid).toBe(process.pid);

    await lock.release();
  });

  test("two locks with different ids do not collide", async () => {
    const a = await acquireWorktreeLock({ cwd, id: "a", branch: "x" });
    const b = await acquireWorktreeLock({ cwd, id: "b", branch: "y" });

    expect(a.path).not.toBe(b.path);

    await a.release();
    await b.release();
  });
});
