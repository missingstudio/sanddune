// Exercises the merge-to-head branch strategy against real Docker.
//
// What it demonstrates:
//   - The agent works in .sanddune/worktrees/<id>/, NOT the host working tree.
//     During the run, your host repo is untouched. Try `git status` in another
//     terminal mid-run — you'll see a clean working tree.
//   - On success, the temp source branch fast-forwards back to the target
//     branch (host HEAD), so the agent's commits end up reachable from your
//     working tree's HEAD.
//   - On a clean close, the worktree is removed and the temp branch is deleted.
//
// Roll back when you're done:
//   git reset --hard HEAD~1
//   rm -f MERGE-TO-HEAD-HELLO.md

import { spawnSync } from "node:child_process";
import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

// ANTHROPIC_API_KEY is read from .sanddune/.env (declared there with either
// the literal value or an empty `KEY=`, in which case sanddune falls back
// to process.env). See ADR-0012.

const headBefore = git("rev-parse", "HEAD");
const branchBefore = git("rev-parse", "--abbrev-ref", "HEAD");
console.log(`host before run: ${branchBefore} @ ${headBefore.slice(0, 12)}`);

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt:
    "Create a file called MERGE-TO-HEAD-HELLO.md at the repo root containing a single line `hello from merge-to-head`. Then commit the change with the message 'add MERGE-TO-HEAD-HELLO.md'. Stop when the commit lands.",
  branchStrategy: { type: "merge-to-head" },
});

const headAfter = git("rev-parse", "HEAD");
console.log("\nrun complete");
console.log(`  source branch:   ${result.sourceBranch}`);
console.log(`  target branch:   ${result.targetBranch}`);
console.log(`  iterations:      ${result.iterations.length}`);
console.log(`  commits:         ${result.commits.length}`);
for (const sha of result.commits) console.log(`    ${sha}`);
console.log(`  host HEAD before: ${headBefore.slice(0, 12)}`);
console.log(`  host HEAD after:  ${headAfter.slice(0, 12)}`);

if (result.worktreePath) {
  console.log(`\n  worktree preserved (dirty): ${result.worktreePath}`);
} else {
  console.log("\n  worktree removed cleanly, temp branch deleted");
}

// Sanity: the temp source branch should not be visible in the host's branch list
// after a clean close.
const branches = git("branch", "--list", "sanddune/merge-to-head/*");
if (branches.trim().length > 0) {
  console.log(`  WARNING: leftover temp branches:\n${branches}`);
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}
