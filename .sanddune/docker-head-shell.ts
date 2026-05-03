// Validates the head branch strategy deterministically by running a shell
// "agent" inside the Docker container — no Claude API involved. Sister to
// docker-merge-to-head-shell.ts; this one writes directly to the host
// working tree.
//
// What it asserts at the end: the agent's commit landed on the host's HEAD
// (head strategy means no merge step), the agent ran with the container's
// own ~/.gitconfig (proves the env-resolver fix — no inline `-c` overrides).
//
// Roll back when you're done:
//   git reset --hard HEAD~1
//   rm -f HEAD-SHELL.md

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentProvider, run } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const headBefore = git("rev-parse", "HEAD");
const branchBefore = git("rev-parse", "--abbrev-ref", "HEAD");
console.log(`host before run: ${branchBefore} @ ${headBefore.slice(0, 12)}`);

// A scripted "agent" that creates a file and commits — no -c overrides.
// The Dockerfile sets user.email/user.name in the container's global config;
// this passes only because resolveEnv strips host-only shell vars (HOME, etc.)
// that would otherwise shadow it.
const shellAgent = createAgentProvider({
  name: "shell-agent",
  buildCommand: () =>
    [
      "echo 'hello from head (shell agent)' > HEAD-SHELL.md",
      "git add HEAD-SHELL.md",
      "git commit -m 'add HEAD-SHELL.md'",
    ].join(" && "),
  parseLine: () => [],
});

const result = await run({
  agent: shellAgent,
  sandbox: docker(),
  prompt: "ignored — buildCommand drives the commit",
  // branchStrategy omitted → defaults to head for bind-mount providers.
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
  failures.push("host HEAD did not advance");
}
if (!existsSync(resolve("HEAD-SHELL.md"))) {
  failures.push("HEAD-SHELL.md is not on the host working tree");
}
if (result.branch !== branchBefore) {
  failures.push(
    `expected branch == host branch (${branchBefore}), got ${result.branch}`,
  );
}

// Identity check: the commit's author should be the Dockerfile's identity,
// proving the container's global ~/.gitconfig was honored (i.e. env-resolver
// did not leak the host's HOME).
const commitAuthor = git("log", "-1", "--pretty=%ae");
if (commitAuthor !== "agent@sanddune.local") {
  failures.push(
    `commit author email is ${commitAuthor}, expected agent@sanddune.local — env-resolver may be leaking HOME into the sandbox`,
  );
}

if (failures.length > 0) {
  console.log("\nFAIL:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.log("\nOK: head strategy + container ~/.gitconfig validated");

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}
