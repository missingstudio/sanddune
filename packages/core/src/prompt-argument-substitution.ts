import type { PromptArgs } from "./prompt";

export const BUILT_IN_PROMPT_ARGS = ["SOURCE_BRANCH", "TARGET_BRANCH"] as const;
export type BuiltInPromptArg = (typeof BUILT_IN_PROMPT_ARGS)[number];

export interface SubstitutePromptArgsInput {
  readonly text: string;
  readonly promptArgs: PromptArgs;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

export interface SubstitutePromptArgsResult {
  readonly text: string;
  /** Keys present in `promptArgs` that did not appear as `{{KEY}}` in the
   *  template. Surfaced for the caller to log — this function never warns. */
  readonly unusedKeys: readonly string[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function substitutePromptArgs(
  input: SubstitutePromptArgsInput,
): SubstitutePromptArgsResult {
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
      `Prompt template references unknown placeholder${
        missing.size > 1 ? "s" : ""
      }: ${list}. Add to promptArgs or remove from the template.`,
    );
  }

  const unusedKeys = Array.from(userKeys).filter((k) => !seenUserKeys.has(k));

  return { text: substituted, unusedKeys };
}
