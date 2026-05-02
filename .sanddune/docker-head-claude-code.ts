import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

// ANTHROPIC_API_KEY is read from .sanddune/.env (declared there with either
// the literal value or an empty `KEY=`, in which case sanddune falls back
// to process.env). See ADR-0012.

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt:
    "Create a file called HELLO.md at the repo root containing a single line `hello from sanddune`. Then commit the change with the message 'add HELLO.md'. Stop when the commit lands.",
});

console.log("\nrun complete");

console.log(`  source branch: ${result.sourceBranch}`);
console.log(`  target branch: ${result.targetBranch}`);
console.log(`  iterations:    ${result.iterations.length}`);
console.log(`  commits:       ${result.commits.length}`);

for (const sha of result.commits) {
  console.log(`    ${sha}`);
}
