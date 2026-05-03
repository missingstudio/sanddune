// Validates the merge-to-head plumbing deterministically by running a shell
// "agent" inside the Docker container — no Claude API involved. Use this when
// you want to exercise the worktree → iteration → merge-back → close lifecycle
// without depending on a slow external service.
//
// What it asserts at the end: the agent's commit landed on the host's HEAD
// (the temp source branch fast-forwarded into target), the temp branch was
// deleted, the worktree was removed cleanly, and the lock was released.
//
// Roll back when you're done:
//   git reset --hard HEAD~1
//   rm -f MERGE-TO-HEAD-SHELL.md

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentProvider, run } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const headBefore = git("rev-parse", "HEAD");
const branchBefore = git("rev-parse", "--abbrev-ref", "HEAD");
console.log(`host before run: ${branchBefore} @ ${headBefore.slice(0, 12)}`);

// A scripted "agent" that creates a file and commits it — no model, no API.
// Relies on the Dockerfile's global ~/.gitconfig for identity. This is only
// reachable because resolveEnv strips host-only shell vars (HOME, USER, ...)
// from the env that flows into the sandbox.
const shellAgent = createAgentProvider({
  name: "shell-agent",
  buildCommand: () =>
    [
      "echo 'hello from merge-to-head (shell agent)' > MERGE-TO-HEAD-SHELL.md",
      "git add MERGE-TO-HEAD-SHELL.md",
      "git commit -m 'add MERGE-TO-HEAD-SHELL.md'",
    ].join(" && "),
  parseLine: () => [],
});

const result = await run({
  agent: shellAgent,
  sandbox: docker(),
  prompt: "ignored — buildCommand drives the commit",
  branchStrategy: { type: "merge-to-head" },
});

const headAfter = git("rev-parse", "HEAD");

console.log("\nrun complete");
console.log(`  branch:           ${result.branch}`);
console.log(`  iterations:       ${result.iterations.length}`);
console.log(`  commits:          ${result.commits.length}`);
for (const sha of result.commits) console.log(`    ${sha}`);
console.log(`  host HEAD before: ${headBefore.slice(0, 12)}`);
console.log(`  host HEAD after:  ${headAfter.slice(0, 12)}`);

const failures: string[] = [];

if (result.commits.length !== 1) {
  failures.push(`expected 1 commit, got ${result.commits.length}`);
}
if (result.commits[0] !== headAfter) {
  failures.push(
    `result.commits[0] (${result.commits[0]}) does not match host HEAD (${headAfter})`,
  );
}
if (headAfter === headBefore) {
  failures.push("host HEAD did not advance — merge-back never landed");
}
if (!existsSync(resolve("MERGE-TO-HEAD-SHELL.md"))) {
  failures.push("MERGE-TO-HEAD-SHELL.md is not on the host working tree");
}
if (result.worktreePath !== undefined) {
  failures.push(
    `worktree was preserved (${result.worktreePath}) — expected clean removal`,
  );
}

const branchList = git("branch", "--list", "sanddune/merge-to-head/*");
if (branchList.trim().length > 0) {
  failures.push(`leftover temp branches:\n${branchList}`);
}

if (failures.length > 0) {
  console.log("\nFAIL:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.log("\nOK: merge-to-head plumbing validated end-to-end");

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}
