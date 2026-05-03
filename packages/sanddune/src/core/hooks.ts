export type SandboxHooks = {
  readonly host?: {
    readonly onWorktreeReady?: ReadonlyArray<{
      readonly command: string;
      readonly timeoutMs?: number;
    }>;
    readonly onSandboxReady?: ReadonlyArray<{
      readonly command: string;
      readonly timeoutMs?: number;
    }>;
  };
  readonly sandbox?: {
    readonly onSandboxReady?: ReadonlyArray<{
      readonly command: string;
      readonly sudo?: boolean;
      readonly timeoutMs?: number;
    }>;
  };
};
