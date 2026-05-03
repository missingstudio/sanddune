import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PromptArgs } from "./prompt";
import type { ExecResult } from "./sandbox-provider";

/** Caller-supplied executor used by the pipeline to evaluate **shell
 *  expressions** inside the **sandbox** during each **iteration**. */
export type SandboxExec = (command: string) => Promise<ExecResult>;

export const BUILT_IN_PROMPT_ARGS = ["SOURCE_BRANCH", "TARGET_BRANCH"] as const;
export type BuiltInPromptArg = (typeof BUILT_IN_PROMPT_ARGS)[number];

export interface PromptPipelineInput {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly promptArgs?: PromptArgs;
  /** Used to substitute the **built-in prompt argument** `{{SOURCE_BRANCH}}`. */
  readonly sourceBranch: string;
  /** Used to substitute the **built-in prompt argument** `{{TARGET_BRANCH}}`. */
  readonly targetBranch: string;
}

export interface PreparedPromptPipeline {
  /** Keys present in `promptArgs` that did not appear as `{{KEY}}` in the
   *  template. Surfaced for the caller to log. Empty for **inline prompts** and
   *  for templates that referenced every supplied key. */
  readonly unusedPromptArgKeys: readonly string[];
  /** Resolves the prompt text for the next **iteration**. For **inline
   *  prompts** and for **prompt templates** with no **shell expressions**,
   *  returns the same string every call without invoking `exec`. For templates
   *  with shell expressions, evaluates them inside the sandbox each call. */
  getPromptForIteration(exec: SandboxExec): Promise<string>;
}

/** Prepare the **prompt** pipeline for one **run session**. Validates options,
 *  reads the file (template), runs **prompt argument substitution** once on
 *  the **host**, and decides whether per-iteration **prompt expansion** is
 *  needed. The returned owner is what the **iteration loop** calls each
 *  iteration. */
export async function preparePromptPipeline(
  input: PromptPipelineInput,
): Promise<PreparedPromptPipeline> {
  const source = await resolveSource(input);

  if (source.kind === "inline") {
    const frozen = source.text;
    return {
      unusedPromptArgKeys: [],
      async getPromptForIteration() {
        return frozen;
      },
    };
  }

  const substituted = substituteArgs({
    text: source.text,
    promptArgs: source.promptArgs,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
  });

  if (!HAS_SHELL_EXPR_RE.test(substituted.text)) {
    const frozen = substituted.text;
    return {
      unusedPromptArgKeys: substituted.unusedKeys,
      async getPromptForIteration() {
        return frozen;
      },
    };
  }

  const baseText = substituted.text;
  return {
    unusedPromptArgKeys: substituted.unusedKeys,
    async getPromptForIteration(exec) {
      return await expandShellExpressions(baseText, exec);
    },
  };
}

type ResolvedSource =
  | { readonly kind: "inline"; readonly text: string }
  | {
    readonly kind: "template";
    readonly text: string;
    readonly promptArgs: PromptArgs;
  };

async function resolveSource(
  input: PromptPipelineInput,
): Promise<ResolvedSource> {
  const hasInline = typeof input.prompt === "string";
  const hasFile = typeof input.promptFile === "string";
  const hasArgs = input.promptArgs !== undefined;

  if (hasInline && hasFile) {
    throw new Error(
      "`prompt` and `promptFile` are mutually exclusive — pass one, not both.",
    );
  }

  if (!hasInline && !hasFile) {
    throw new Error(
      "A prompt is required — pass either `prompt` (inline) or `promptFile` (template).",
    );
  }

  if (hasInline) {
    if (hasArgs) {
      throw new Error(
        "`promptArgs` cannot be combined with an inline `prompt` — `promptArgs` only applies to `promptFile` templates (see ADR-0008).",
      );
    }
    return { kind: "inline", text: input.prompt as string };
  }

  const promptFile = input.promptFile as string;
  const absolutePath = isAbsolute(promptFile)
    ? promptFile
    : resolvePath(process.cwd(), promptFile);

  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`promptFile not found: ${absolutePath}`);
    }
    throw cause;
  }

  return { kind: "template", text, promptArgs: input.promptArgs ?? {} };
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
// No escape mechanism for literal backticks — the syntax is meant for short
// fetches (`gh issue view 42`, `git log -1`).
const SHELL_EXPRESSION_RE = /!`([^`]*)`/g;
const HAS_SHELL_EXPR_RE = /!`[^`]*`/;

interface SubstituteInput {
  readonly text: string;
  readonly promptArgs: PromptArgs;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}
interface SubstituteResult {
  readonly text: string;
  readonly unusedKeys: readonly string[];
}

function substituteArgs(input: SubstituteInput): SubstituteResult {
  const { text, promptArgs, sourceBranch, targetBranch } = input;

  for (const key of Object.keys(promptArgs)) {
    if (!KEY_RE.test(key)) {
      throw new Error(
        `Invalid promptArgs key "${key}" — keys must match /^[A-Za-z_][A-Za-z0-9_]*$/ to be referenceable as {{KEY}} in a template.`,
      );
    }
  }

  for (const reserved of BUILT_IN_PROMPT_ARGS) {
    if (Object.prototype.hasOwnProperty.call(promptArgs, reserved)) {
      throw new Error(
        `Built-in prompt argument {{${reserved}}} cannot be overridden via promptArgs.`,
      );
    }
  }

  const userKeys = new Set(Object.keys(promptArgs));
  const seenUserKeys = new Set<string>();
  const missing = new Set<string>();

  const substituted = text.replace(PLACEHOLDER_RE, (match, key: string) => {
    if (key === "SOURCE_BRANCH") return sourceBranch;
    if (key === "TARGET_BRANCH") return targetBranch;
    if (userKeys.has(key)) {
      seenUserKeys.add(key);
      return String(promptArgs[key]);
    }
    missing.add(key);
    return match;
  });

  if (missing.size > 0) {
    const list = Array.from(missing)
      .map((k) => `{{${k}}}`)
      .join(", ");
    // TODO(#15): interactive() will prompt the user to fill in missing values
    // instead of throwing.
    throw new Error(
      `Prompt template references unknown placeholder${missing.size > 1 ? "s" : ""
      }: ${list}. Add to promptArgs or remove from the template.`,
    );
  }

  const unusedKeys = Array.from(userKeys).filter((k) => !seenUserKeys.has(k));
  return { text: substituted, unusedKeys };
}

/** Trailing newlines on each command's stdout are stripped (POSIX `$(cmd)`
 *  semantics). All shell expressions in a single prompt run in parallel; a
 *  non-zero exit — or a thrown rejection from `exec` (e.g. sandbox died) —
 *  rejects with the offending command. */
async function expandShellExpressions(
  text: string,
  exec: SandboxExec,
): Promise<string> {
  const matches = Array.from(text.matchAll(SHELL_EXPRESSION_RE));
  if (matches.length === 0) return text;

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
          `Shell expression failed: !\`${command}\` — ${cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      });
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim();
        throw new Error(
          `Shell expression failed (exit ${result.exitCode}): !\`${command}\`${detail ? `\n${detail}` : ""
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
  return out;
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}
