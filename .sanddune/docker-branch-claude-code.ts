// Exercises the branch (named) strategy against real Docker.
//
// What it demonstrates:
//   - The agent works in .sanddune/worktrees/<sanitized-name>/, NOT the host
//     working tree. During the run, your host repo is untouched.
//   - The commit lands on the named branch (`sanddune/branch-demo`). There is
//     no merge-back — host HEAD stays put. After the run, the named branch
//     points at the agent's commit; you can `git log sanddune/branch-demo`
//     or `git checkout sanddune/branch-demo` to inspect or pick it up.
//   - On a re-run with the same branch name, the worktree is reused and the
//     new commit appends to the existing tip (per ADR-0003). Try it twice.
//   - On a clean close, the worktree is removed; the named branch is preserved.
//
// Roll back when you're done:
//   git branch -D sanddune/branch-demo

import { spawnSync } from "node:child_process";
import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const BRANCH = "sanddune/branch-demo";

const headBefore = git("rev-parse", "HEAD");
const branchBefore = git("rev-parse", "--abbrev-ref", "HEAD");
console.log(`host before run: ${branchBefore} @ ${headBefore.slice(0, 12)}`);

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt:
    "Create a file called BRANCH-HELLO.md at the repo root containing a single line `hello from branch strategy`. Then commit the change with the message 'add BRANCH-HELLO.md'. Stop when the commit lands.",
  branchStrategy: { type: "branch", branch: BRANCH },
});

const headAfter = git("rev-parse", "HEAD");
const branchTip = gitOrEmpty("rev-parse", BRANCH);

console.log("\nrun complete");
console.log(`  branch:           ${result.branch}`);
console.log(`  iterations:       ${result.iterations.length}`);
console.log(`  commits:          ${result.commits.length}`);
for (const sha of result.commits) console.log(`    ${sha}`);
console.log(`  host HEAD before: ${headBefore.slice(0, 12)}`);
console.log(`  host HEAD after:  ${headAfter.slice(0, 12)}  (unchanged)`);
console.log(`  ${BRANCH} tip:    ${branchTip.slice(0, 12)}`);

if (result.worktreePath) {
  console.log(`\n  worktree preserved (dirty): ${result.worktreePath}`);
} else {
  console.log("\n  worktree removed cleanly; named branch preserved on disk");
}

if (headAfter !== headBefore) {
  console.log("  WARNING: host HEAD moved — branch strategy should not touch it");
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function gitOrEmpty(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}
