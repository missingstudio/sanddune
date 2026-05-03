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

/**
 * The sandbox-side command runner. `ExecOptions` (cwd, sudo, onLine) is
 * deliberately not plumbed: shell expressions are short, default-cwd fetches,
 * and per-command options would require a syntax extension. Out of scope here.
 */
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
 * newlines trimmed, matching POSIX `$(cmd)` semantics).
 *
 * All shell expressions in a single prompt run in parallel. A non-zero exit
 * — or a thrown rejection from `exec` itself (e.g. sandbox died) — rejects
 * the call with the offending command attached for context; remaining
 * commands continue to run on the sandbox but their results are discarded.
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

  for (const m of matches) {
    if (m[1] === "") {
      throw new Error(
        "Empty shell expression: !`` — shell expressions must contain a command.",
      );
    }
  }

  const replacements = await Promise.all(
    matches.map(async (m) => {
      const command = m[1]!;
      const result = await exec(command).catch((cause: unknown): never => {
        throw new Error(
          `Shell expression failed: !\`${command}\` — ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      });
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim();
        throw new Error(
          `Shell expression failed (exit ${result.exitCode}): !\`${command}\`${
            detail ? `\n${detail}` : ""
          }`,
        );
      }
      return {
        index: m.index!,
        length: m[0].length,
        replacement: stripTrailingNewlines(result.stdout),
      };
    }),
  );

  let cursor = 0;
  let out = "";
  for (const { index, length, replacement } of replacements) {
    out += text.slice(cursor, index);
    out += replacement;
    cursor = index + length;
  }
  out += text.slice(cursor);

  return { text: out };
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}
