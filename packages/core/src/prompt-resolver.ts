import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PromptArgs } from "./prompt";

export type ResolvedPrompt =
  | {
      readonly kind: "inline";
      readonly text: string;
    }
  | {
      readonly kind: "template";
      readonly text: string;
      readonly promptArgs: PromptArgs;
      readonly absolutePath: string;
    };

export interface PromptResolverInput {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly promptArgs?: PromptArgs;
}

export async function resolvePrompt(
  input: PromptResolverInput,
): Promise<ResolvedPrompt> {
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

  return {
    kind: "template",
    text,
    promptArgs: input.promptArgs ?? {},
    absolutePath,
  };
}
