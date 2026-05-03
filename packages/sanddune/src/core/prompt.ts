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

/** Like `PromptOption`, but every field is optional — the user may launch
 *  `interactive()` / `wt.interactive()` with no seed prompt at all. The
 *  `prompt` + `promptFile` and `prompt` + `promptArgs` mutual-exclusion
 *  rules still hold. */
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
