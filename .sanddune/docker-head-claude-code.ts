import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

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
