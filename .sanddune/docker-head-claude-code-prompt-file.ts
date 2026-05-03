// Exercises the promptFile path through PromptResolver against real Docker.
//
// What it demonstrates:
//   - run() accepts `promptFile` instead of `prompt`. The resolver reads the
//     file from disk and forwards the contents to the agent as-is.
//   - `promptFile` resolves relative to process.cwd() (the caller's
//     perspective), NOT RunOptions.cwd — so this script must be launched
//     from the repo root for the relative path below to find the template.
//   - {{KEY}} substitution and !`...` shell expansion are not implemented
//     yet (later slices), so the template is plain text today.

import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  promptFile: ".sanddune/prompts/hello-prompt-file.md",
});

console.log("\nrun complete");
console.log(`  branch:        ${result.branch}`);
console.log(`  iterations:    ${result.iterations.length}`);
console.log(`  commits:       ${result.commits.length}`);

for (const sha of result.commits) {
  console.log(`    ${sha}`);
}
