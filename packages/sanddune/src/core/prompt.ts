export type PromptArgs = Readonly<Record<string, string | number>>;

export type PromptOption =
  | {
      readonly prompt: string;
      readonly promptFile?: never;
      readonly promptArgs?: never;
    }
  | {
      readonly prompt?: never;
      readonly promptFile: string;
      readonly promptArgs?: PromptArgs;
    };

/** Mutual-exclusion of prompt+promptFile and prompt+promptArgs still holds. */
export type OptionalPromptOption =
  | {
      readonly prompt?: string;
      readonly promptFile?: never;
      readonly promptArgs?: never;
    }
  | {
      readonly prompt?: never;
      readonly promptFile: string;
      readonly promptArgs?: PromptArgs;
    };
