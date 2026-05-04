import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PromptArgs } from "./prompt";
import type { ExecResult } from "./sandbox-provider";

export type SandboxExec = (command: string) => Promise<ExecResult>;

export const BUILT_IN_PROMPT_ARGS = ["SOURCE_BRANCH", "TARGET_BRANCH"] as const;
export type BuiltInPromptArg = (typeof BUILT_IN_PROMPT_ARGS)[number];

export interface PromptPipelineInput {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly promptArgs?: PromptArgs;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

export interface PreparedPromptPipeline {
  readonly unusedPromptArgKeys: readonly string[];
  /** Returns a frozen string for inline / shell-expression-free templates;
   *  evaluates shell expressions inside the sandbox otherwise. */
  getPromptForIteration(exec: SandboxExec): Promise<string>;
}

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
    throw new Error(
      `Prompt template references unknown placeholder${missing.size > 1 ? "s" : ""
      }: ${list}. Add to promptArgs or remove from the template.`,
    );
  }

  const unusedKeys = Array.from(userKeys).filter((k) => !seenUserKeys.has(k));
  return { text: substituted, unusedKeys };
}

/** Trailing newlines stripped (POSIX $(cmd) semantics). Shell expressions
 *  run in parallel. */
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
