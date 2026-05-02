import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultImageName,
  resolveParentGitMount,
} from "./bind-mount-provisioning";

describe("defaultImageName", () => {
  test("uses the basename of the host repo path", () => {
    expect(defaultImageName("/Users/me/projects/sanddune")).toBe(
      "sanddune:sanddune",
    );
  });

  test("strips trailing slashes", () => {
    expect(defaultImageName("/Users/me/projects/sanddune/")).toBe(
      "sanddune:sanddune",
    );
    expect(defaultImageName("/Users/me/projects/sanddune///")).toBe(
      "sanddune:sanddune",
    );
  });

  test("lowercases", () => {
    expect(defaultImageName("/Users/me/Projects/MyRepo")).toBe(
      "sanddune:myrepo",
    );
  });

  test("sanitizes invalid characters to '-'", () => {
    expect(defaultImageName("/Users/me/My Repo (v2)")).toBe(
      "sanddune:my-repo--v2-",
    );
  });

  test("preserves underscores, dots, and hyphens", () => {
    expect(defaultImageName("/Users/me/my_repo.dir-name")).toBe(
      "sanddune:my_repo.dir-name",
    );
  });

  test("falls back to 'local' when the path has no usable basename", () => {
    expect(defaultImageName("/")).toBe("sanddune:local");
    expect(defaultImageName("")).toBe("sanddune:local");
  });

  test("handles backslashes (Windows-style paths)", () => {
    expect(defaultImageName("C:\\Users\\me\\projects\\sanddune")).toBe(
      "sanddune:sanddune",
    );
  });
});

describe("resolveParentGitMount", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sanddune-prov-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns null when the worktree's .git is a directory", async () => {
    const wt = join(tmp, "regular-checkout");
    await mkdir(join(wt, ".git"), { recursive: true });
    expect(await resolveParentGitMount(wt)).toBeNull();
  });

  test("returns null when the worktree has no .git at all", async () => {
    const wt = join(tmp, "no-git");
    await mkdir(wt, { recursive: true });
    expect(await resolveParentGitMount(wt)).toBeNull();
  });

  test("returns the parent .git mount when .git is a pointer file", async () => {
    const repo = join(tmp, "repo");
    const parentGit = join(repo, ".git");
    await mkdir(join(parentGit, "worktrees", "wt-1"), { recursive: true });

    const wt = join(tmp, "wts", "wt-1");
    await mkdir(wt, { recursive: true });
    await writeFile(
      join(wt, ".git"),
      `gitdir: ${join(parentGit, "worktrees", "wt-1")}\n`,
    );

    const mount = await resolveParentGitMount(wt);
    expect(mount).toEqual({ hostPath: parentGit, sandboxPath: parentGit });
  });

  test("tolerates trailing whitespace in the gitdir pointer", async () => {
    const repo = join(tmp, "repo");
    const parentGit = join(repo, ".git");
    await mkdir(join(parentGit, "worktrees", "wt-1"), { recursive: true });

    const wt = join(tmp, "wts", "wt-1");
    await mkdir(wt, { recursive: true });
    await writeFile(
      join(wt, ".git"),
      `gitdir: ${join(parentGit, "worktrees", "wt-1")}   \n\n`,
    );

    const mount = await resolveParentGitMount(wt);
    expect(mount?.hostPath).toBe(parentGit);
  });

  test("returns null when the pointer file is malformed", async () => {
    const wt = join(tmp, "bad-pointer");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), "this is not a gitdir line\n");

    expect(await resolveParentGitMount(wt)).toBeNull();
  });

  test("returns null when the gitdir path has no .git segment", async () => {
    const wt = join(tmp, "weird-pointer");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, ".git"), "gitdir: /some/random/path\n");

    expect(await resolveParentGitMount(wt)).toBeNull();
  });
});
