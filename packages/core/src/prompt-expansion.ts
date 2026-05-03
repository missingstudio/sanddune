import type { ExecResult } from "./sandbox-provider";

/**
 * Matches a shell expression `` !`command` `` in a prompt template.
 *
 * The body is non-greedy: anything except a backtick. There is no escape
 * mechanism for literal backticks inside the command — by design, the syntax
 * is meant for short fetches (`gh issue view 42`, `git log -1`). Multi-line
 * bodies are allowed (the body matcher does not exclude newlines), but in
 * practice every expression is a single line.
 */
const SHELL_EXPRESSION_RE = /!`([^`]*)`/g;

export type SandboxExec = (command: string) => Promise<ExecResult>;

export interface ExpandPromptInput {
  readonly text: string;
  /**
   * The sandbox-side command runner. In `run()` this is bound to the live
   * sandbox handle's `exec`; in tests it is a fake.
   */
  readonly exec: SandboxExec;
}

export interface ExpandPromptResult {
  readonly text: string;
}

/**
 * Performs **prompt expansion**: evaluates every **shell expression**
 * (`` !`command` ``) in the **prompt** by running the command **inside the
 * sandbox** and replacing the marker with the command's stdout (trailing
 * newline trimmed).
 *
 * All shell expressions in a single prompt run in parallel. A non-zero exit
 * from any expression rejects the call with the offending command and exit
 * code; remaining commands continue to run on the sandbox but their results
 * are discarded.
 *
 * Inline prompts skip this stage entirely — the caller is responsible for
 * that gating (see ADR-0008 / `resolvePrompt`).
 */
export async function expandPrompt(
  input: ExpandPromptInput,
): Promise<ExpandPromptResult> {
  const { text, exec } = input;

  const matches = Array.from(text.matchAll(SHELL_EXPRESSION_RE));
  if (matches.length === 0) {
    return { text };
  }

  const results = await Promise.all(
    matches.map(async (m) => {
      const command = m[1] as string;
      const result = await exec(command);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim();
        throw new Error(
          `Shell expression failed (exit ${result.exitCode}): !\`${command}\`${
            detail ? `\n${detail}` : ""
          }`,
        );
      }
      return result;
    }),
  );

  let cursor = 0;
  let out = "";
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i] as RegExpMatchArray;
    const idx = m.index as number;
    out += text.slice(cursor, idx);
    out += stripTrailingNewline((results[i] as ExecResult).stdout);
    cursor = idx + m[0].length;
  }
  out += text.slice(cursor);

  return { text: out };
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}
