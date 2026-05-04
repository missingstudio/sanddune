import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface WorktreeLockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export interface AcquireWorktreeLockOptions {
  readonly cwd: string;
  readonly id: string;
  readonly branch: string;
}

interface LockOwner {
  readonly pid: number;
  readonly branch: string;
  readonly acquiredAt: string;
}

export async function acquireWorktreeLock(
  options: AcquireWorktreeLockOptions,
): Promise<WorktreeLockHandle> {
  const lockPath = lockPathFor(options.cwd, options.id);
  await mkdir(dirname(lockPath), { recursive: true });

  const payload = JSON.stringify({
    pid: process.pid,
    branch: options.branch,
    acquiredAt: new Date().toISOString(),
  } satisfies LockOwner);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(payload);
      } finally {
        await handle.close();
      }
      return makeHandle(lockPath);
    } catch (err) {
      if (!isEEXIST(err)) throw err;
      const owner = await readLockOwner(lockPath);
      if (owner && isPidAlive(owner.pid)) {
        throw new Error(
          `Worktree lock is held by process ${owner.pid} (branch "${owner.branch}", since ${owner.acquiredAt}). ` +
            `Refusing to share the worktree across concurrent runs.`,
        );
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`Failed to acquire worktree lock at ${lockPath}`);
}

function lockPathFor(cwd: string, id: string): string {
  return join(resolve(cwd), ".sanddune", "locks", `${id}.lock`);
}

function makeHandle(lockPath: string): WorktreeLockHandle {
  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) return;
      released = true;
      await rm(lockPath, { force: true });
    },
  };
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const text = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(text) as Partial<LockOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.branch === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      return {
        pid: parsed.pid,
        branch: parsed.branch,
        acquiredAt: parsed.acquiredAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it.
    if (code === "EPERM") return true;
    return false;
  }
}

function isEEXIST(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EEXIST";
}
