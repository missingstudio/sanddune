import { randomBytes } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runGit } from "./git";
import { spawnHost } from "./host-process";
import {
  acquireWorktreeLock,
  type WorktreeLockHandle,
} from "./worktree-lock";

export interface ManagedWorktree {
  readonly id: string;
  readonly path: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  isDirty(): Promise<boolean>;
  close(): Promise<ManagedWorktreeCloseResult>;
}

export interface ManagedWorktreeCloseResult {
  readonly preserved: boolean;
  readonly path?: string;
}

export interface CreateMergeToHeadWorktreeOptions {
  readonly cwd: string;
  readonly targetBranch: string;
}

export async function createMergeToHeadWorktree(
  options: CreateMergeToHeadWorktreeOptions,
): Promise<ManagedWorktree> {
  const cwd = resolve(options.cwd);
  const id = newWorktreeId();
  const sourceBranch = `sanddune/merge-to-head/${id}`;
  const worktreePath = join(cwd, ".sanddune", "worktrees", id);

  await mkdir(dirname(worktreePath), { recursive: true });

  const lock: WorktreeLockHandle = await acquireWorktreeLock({
    cwd,
    id,
    branch: sourceBranch,
  });

  try {
    await runGit(cwd, [
      "worktree",
      "add",
      "-b",
      sourceBranch,
      worktreePath,
      "HEAD",
    ]);
  } catch (err) {
    await lock.release();
    throw err;
  }

  let closed = false;
  return {
    id,
    path: worktreePath,
    sourceBranch,
    targetBranch: options.targetBranch,
    isDirty: () => gitStatusIsDirty(worktreePath),
    close: async () => {
      if (closed) return { preserved: false };
      closed = true;
      try {
        const dirty = await gitStatusIsDirty(worktreePath);
        if (dirty) {
          return { preserved: true, path: worktreePath };
        }
        await runGit(cwd, ["worktree", "remove", "--force", worktreePath]);
        return { preserved: false };
      } finally {
        await lock.release();
      }
    },
  };
}

export interface CreateBranchWorktreeOptions {
  readonly cwd: string;
  readonly branch: string;
  readonly targetBranch: string;
}

export async function createBranchWorktree(
  options: CreateBranchWorktreeOptions,
): Promise<ManagedWorktree> {
  const cwd = resolve(options.cwd);
  const id = sanitizeBranchForPath(options.branch);
  const worktreePath = join(cwd, ".sanddune", "worktrees", id);

  await mkdir(dirname(worktreePath), { recursive: true });

  const lock: WorktreeLockHandle = await acquireWorktreeLock({
    cwd,
    id,
    branch: options.branch,
  });

  try {
    const checkoutPath = await getWorktreePathForBranch(cwd, options.branch);
    const sameAsOurs =
      checkoutPath !== null && (await samePath(checkoutPath, worktreePath));
    if (checkoutPath !== null && !sameAsOurs) {
      throw new Error(
        `Branch "${options.branch}" is already checked out at ${checkoutPath}; refusing to create a second worktree for it.`,
      );
    }

    const dirExists = await pathExists(worktreePath);
    if (sameAsOurs && dirExists) {
      const dirty = await gitStatusIsDirty(worktreePath);
      if (dirty) {
        process.stderr.write(
          `sanddune: reusing existing worktree at ${worktreePath} for branch "${options.branch}" — uncommitted changes are present and will be visible to the agent.\n`,
        );
      } else {
        process.stdout.write(
          `sanddune: reusing existing worktree at ${worktreePath} for branch "${options.branch}".\n`,
        );
      }
    } else {
      const branchExists = await gitBranchExists(cwd, options.branch);
      if (branchExists) {
        await runGit(cwd, ["worktree", "add", worktreePath, options.branch]);
      } else {
        await runGit(cwd, [
          "worktree",
          "add",
          "-b",
          options.branch,
          worktreePath,
          "HEAD",
        ]);
      }
    }
  } catch (err) {
    await lock.release();
    throw err;
  }

  let closed = false;
  return {
    id,
    path: worktreePath,
    sourceBranch: options.branch,
    targetBranch: options.targetBranch,
    isDirty: () => gitStatusIsDirty(worktreePath),
    close: async () => {
      if (closed) return { preserved: false };
      closed = true;
      try {
        const dirty = await gitStatusIsDirty(worktreePath);
        if (dirty) {
          return { preserved: true, path: worktreePath };
        }
        await runGit(cwd, ["worktree", "remove", "--force", worktreePath]);
        return { preserved: false };
      } finally {
        await lock.release();
      }
    },
  };
}

// `agent/foo` → `agent-foo` so it fits a single directory segment.
function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/\//g, "-");
}

// `git worktree list --porcelain` resolves symlinks (macOS `/var/...` →
// `/private/var/...`), but our paths are built via `path.join` and don't.
async function samePath(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const [ra, rb] = await Promise.all([realpath(a), realpath(b)]);
    return ra === rb;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function gitBranchExists(cwd: string, branch: string): Promise<boolean> {
  // Exit code carries the answer — bypass runGit's throw-on-nonzero.
  const result = await spawnHost(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd },
  );
  return result.exitCode === 0;
}

async function getWorktreePathForBranch(
  cwd: string,
  branch: string,
): Promise<string | null> {
  const result = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  const wanted = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && currentPath) {
      const ref = line.slice("branch ".length);
      if (ref === wanted) return currentPath;
    } else if (line.length === 0) {
      currentPath = null;
    }
  }
  return null;
}

function newWorktreeId(): string {
  const date = new Date();
  const stamp =
    date.getUTCFullYear().toString().padStart(4, "0") +
    (date.getUTCMonth() + 1).toString().padStart(2, "0") +
    date.getUTCDate().toString().padStart(2, "0") +
    "-" +
    date.getUTCHours().toString().padStart(2, "0") +
    date.getUTCMinutes().toString().padStart(2, "0") +
    date.getUTCSeconds().toString().padStart(2, "0");
  const suffix = randomBytes(3).toString("hex");
  return `${stamp}-${suffix}`;
}

async function gitStatusIsDirty(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}

/** Best-effort hygiene; swallows errors so prune failures don't block
 *  worktree creation. */
export async function pruneStaleWorktrees(cwd: string): Promise<void> {
  try {
    await runGit(cwd, ["worktree", "prune"]);
  } catch {
    // hygiene, not correctness
  }
}
