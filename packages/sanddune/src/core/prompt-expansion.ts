import type { ExecResult } from "./sandbox-provider";

// No escape mechanism for literal backticks — the syntax is meant for short
// fetches (`gh issue view 42`, `git log -1`).
const SHELL_EXPRESSION_RE = /!`([^`]*)`/g;

/** `ExecOptions` (cwd, sudo, onLine) is not plumbed: shell expressions are
 *  short, default-cwd fetches; per-command options would need a syntax
 *  extension. */
export type SandboxExec = (command: string) => Promise<ExecResult>;

export interface ExpandPromptInput {
  readonly text: string;
  readonly exec: SandboxExec;
}

export interface ExpandPromptResult {
  readonly text: string;
}

/** Trailing newlines on each command's stdout are stripped (POSIX `$(cmd)`
 *  semantics). All shell expressions in a single prompt run in parallel; a
 *  non-zero exit — or a thrown rejection from `exec` (e.g. sandbox died) —
 *  rejects with the offending command. Inline prompts skip this entirely
 *  per ADR-0008 (caller-side gating). */
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
