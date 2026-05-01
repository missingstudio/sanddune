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
